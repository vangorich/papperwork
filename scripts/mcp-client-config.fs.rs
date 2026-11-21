//! A config and its ownership receipt are a single NTFS transaction. A check followed by
//! ReplaceFileW (or an advisory lock file) would lose an unrelated client's racing rename.
//! Unsupported volumes, sharing violations and interrupted installs must fail closed.
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::*,
};

pub fn local_path(path: &Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
        && matches!(components.next(), Some(Component::RootDir))
        && components.all(|c| matches!(c, Component::Normal(v) if v.to_str().is_some_and(|s| !s.contains([':', '"']) && !s.chars().any(char::is_control))))
}

// Keep every traversed directory in place until commit; don't follow a redirected profile.
pub fn pin(path: &Path) -> io::Result<File> {
    let f = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let m = f.metadata()?;
    if !m.is_dir() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("not an ordinary profile directory"));
    }
    Ok(f)
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}
fn handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: caller passes a newly owned kernel handle, checked above, closed once by RAII.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn success(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub struct Transaction(OwnedHandle);
impl Transaction {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null optional pointers select the documented defaults. Closing an
        // uncommitted transaction's last handle rolls it back, including on process exit.
        Ok(Self(handle(unsafe {
            CreateTransaction(null_mut(), null_mut(), 0, 0, 0, 0, null())
        })?))
    }
    pub fn open(&self, path: &Path, create_new: bool) -> io::Result<File> {
        let path = wide(path.as_os_str());
        // SAFETY: path is NUL terminated, the transaction handle stays live; no borrowed
        // pointers escape this call. CREATE_NEW never replaces an existing path.
        let file = File::from(handle(unsafe {
            CreateFileTransactedW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ,
                null(),
                if create_new {
                    CREATE_NEW
                } else {
                    OPEN_EXISTING
                },
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
                self.0.as_raw_handle(),
                null(),
                null(),
            )
        })?);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: the OS fills the correctly sized structure via a live file handle.
        success(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || info.nNumberOfLinks != 1
        {
            return Err(io::Error::other("not an ordinary single-link config file"));
        }
        Ok(file)
    }
    pub fn delete(&self, path: &Path) -> io::Result<()> {
        let path = wide(path.as_os_str());
        // SAFETY: the caller enlisted and checked this file within the same transaction.
        success(unsafe { DeleteFileTransactedW(path.as_ptr(), self.0.as_raw_handle()) })
    }
    pub fn commit(self) -> io::Result<()> {
        // SAFETY: the handle is valid until after the synchronous commit.
        success(unsafe { CommitTransaction(self.0.as_raw_handle()) })
    }
}

pub fn optional<T>(r: io::Result<T>) -> io::Result<Option<T>> {
    match r {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn read(file: &mut File, limit: u64) -> io::Result<String> {
    if file.metadata()?.len() > limit {
        return Err(io::Error::other("file is too large"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?; // No lossy decoding; preserve UTF-8 BOM in the caller.
    Ok(text)
}
pub fn write(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.rewind()?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)
}
