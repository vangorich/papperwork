//! The picker grants one new Markdown leaf, never a renderer-supplied path. Images
//! are create-only in a new sibling directory; the Markdown is published last.
use crate::{
    database::Database,
    documents::{blocking, dialog, safe_leaf},
    native_features::trusted,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, WebviewWindow,
};
use tempfile::NamedTempFile;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MIB: usize = 1024 * 1024;
const MAX_ART_BYTES: usize = 32 * MIB;
const MAX_IMAGES: usize = 256;
const EXPIRED: &str = "Markdown 保存授权已取消或失效";
// These errors can reach MCP export_status. tempfile's Display embeds the full local
// path on some failures, so expose the reason, not the underlying path or OS message.
fn err(e: io::Error) -> String {
    match e.kind() {
        io::ErrorKind::AlreadyExists => "目标已存在，不会覆盖。请另选名称。",
        io::ErrorKind::NotFound => "保存位置已不存在，请重新选择。",
        io::ErrorKind::PermissionDenied => "没有写入权限，或文件正在使用。请另选位置。",
        io::ErrorKind::StorageFull => "磁盘空间不足，无法完成导出。",
        _ => "无法完成写入，请检查磁盘和保存位置后重试。",
    }
    .into()
}

fn markdown_leaf(name: &str) -> bool {
    safe_leaf(name) && name.len() > 3 && name.to_ascii_lowercase().ends_with(".md")
}
fn image_leaf(name: &str, bytes: &[u8]) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    safe_leaf(name)
        && !stem.is_empty()
        && stem.len() <= 96
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && match ext {
            "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        }
}

#[cfg(windows)]
mod handles {
    use super::*;
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const DELETE: u32 = 0x0001_0000;
    const READ_ATTRIBUTES: u32 = 0x80;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const SHARE_READ: u32 = 1;

    pub(super) fn open_dir(path: &Path, owned: bool) -> io::Result<File> {
        let f = OpenOptions::new()
            .access_mode(READ_ATTRIBUTES | if owned { DELETE } else { 0 })
            .share_mode(SHARE_READ)
            .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
            .open(path)?;
        let md = f.metadata()?;
        if !md.is_dir() || md.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("导出目录已改变"));
        }
        Ok(f)
    }
    pub(super) fn create_image(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_WRITE | DELETE)
            .share_mode(SHARE_READ)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(path)
    }
    // Mark the *open object* for deletion. Closing first and then unlinking its old
    // pathname could delete somebody else's replacement file. For a nonempty dir
    // Windows refuses the operation, preserving independently added children.
    pub(super) fn discard(file: &File, _: &Path, _: bool) {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileInformationByHandle(
                handle: std::os::windows::io::RawHandle,
                class: i32,
                info: *const std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let delete: u8 = 1; // FILE_DISPOSITION_INFO.DeleteFile (BOOLEAN)
                            // SAFETY: a live DELETE-capable handle, FileDispositionInfo (4), and its one-byte input.
        unsafe {
            SetFileInformationByHandle(file.as_raw_handle(), 4, (&delete as *const u8).cast(), 1);
        }
    }
}
#[cfg(not(windows))]
mod handles {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    pub(super) fn open_dir(path: &Path, _: bool) -> io::Result<File> {
        if !path.symlink_metadata()?.is_dir() {
            return Err(io::Error::other("导出目录已改变"));
        }
        File::open(path)
    }
    pub(super) fn create_image(path: &Path) -> io::Result<File> {
        File::create_new(path)
    }
    pub(super) fn discard(file: &File, path: &Path, dir: bool) {
        if let (Ok(held), Ok(now)) = (file.metadata(), path.symlink_metadata()) {
            if held.dev() == now.dev() && held.ino() == now.ino() {
                let _ = if dir {
                    fs::remove_dir(path)
                } else {
                    fs::remove_file(path)
                };
            }
        }
    }
}

struct Directory {
    path: PathBuf,
    // Hold the canonical parent chain without write/delete sharing for the lifetime of the picker grant.
    _pins: Vec<File>,
}
impl Directory {
    fn pin(path: &Path) -> Result<Self> {
        let path = dunce::canonicalize(path).map_err(err)?;
        let mut chain: Vec<_> = path.ancestors().filter(|p| p.has_root()).collect();
        chain.reverse();
        let pins = chain
            .into_iter()
            .map(|p| handles::open_dir(p, false))
            .collect::<io::Result<_>>()
            .map_err(err)?;
        Ok(Self { path, _pins: pins })
    }
    fn check(&self) -> Result<()> {
        if dunce::canonicalize(&self.path).map_err(err)? != self.path {
            return Err("保存目录已改变，请重新选择".into());
        }
        Ok(())
    }
}
struct NewEntry {
    path: PathBuf,
    file: File,
    directory: bool,
    keep: bool,
}
impl Drop for NewEntry {
    fn drop(&mut self) {
        if !self.keep {
            handles::discard(&self.file, &self.path, self.directory);
        }
    }
}
struct Export {
    // Drop files before the directory and the directory before its parent pins. Never remove_dir_all.
    images: Vec<NewEntry>,
    directory: Option<NewEntry>,
    parent: Arc<Directory>,
    target: PathBuf,
    bytes_written: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ticket {
    token: String,
    name: String,
    asset_directory: String,
}

fn reserve_images(parent: &Path, stem: &str) -> Result<NewEntry> {
    // Keep the link human-readable, without a leading dot, Windows device, or URL/Markdown metacharacters.
    let slug: String = stem
        .chars()
        .take(64)
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = format!("{slug}-images");
    for n in 1..=1024 {
        let path = parent.join(if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        });
        match fs::create_dir(&path) {
            Ok(()) => {
                // Do not remove the path on open failure: another process may have replaced it.
                let file = handles::open_dir(&path, true).map_err(err)?;
                return Ok(NewEntry {
                    path,
                    file,
                    directory: true,
                    keep: false,
                });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(err(e)),
        }
    }
    Err("同名插图目录过多，请选择其他 Markdown 文件名".into())
}

#[derive(Default)]
pub(crate) struct MarkdownExports(Mutex<HashMap<String, Export>>);
impl MarkdownExports {
    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Export>>> {
        self.0.lock().map_err(|_| "Markdown 保存锁无效".into())
    }
    fn issue(&self, picked: &Path, include_images: bool) -> Result<Ticket> {
        let name = picked
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| markdown_leaf(s))
            .ok_or("请选择有效的新 .md 文件名")?;
        let parent = Arc::new(Directory::pin(picked.parent().ok_or("没有保存目录")?)?);
        let target = parent.path.join(name);
        match target.symlink_metadata() {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Ok(_) => return Err("目标已存在。Markdown 导出不会覆盖已有文件，请另选名称。".into()),
            Err(e) => return Err(err(e)),
        }
        let mut grants = self.lock()?;
        if grants.len() >= 4 {
            return Err("正在处理其他 Markdown 导出，请先完成或取消".into());
        }
        let directory = if include_images {
            Some(reserve_images(&parent.path, &name[..name.len() - 3])?)
        } else {
            None
        };
        let asset_directory = directory
            .as_ref()
            .and_then(|d| d.path.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_owned();
        let token = Uuid::new_v4().to_string();
        grants.insert(
            token.clone(),
            Export {
                images: Vec::new(),
                directory,
                parent,
                target,
                bytes_written: 0,
            },
        );
        Ok(Ticket {
            token,
            name: name.to_owned(),
            asset_directory,
        })
    }
    fn image(&self, token: &str, name: &str, bytes: &[u8]) -> Result<()> {
        let mut grants = self.lock()?;
        let export = grants.get_mut(token).ok_or(EXPIRED)?;
        let result = (|| {
            let dir = export.directory.as_ref().ok_or("本次导出不含插图")?;
            if !image_leaf(name, bytes)
                || export.images.len() >= MAX_IMAGES
                || bytes.len() > MAX_ART_BYTES - export.bytes_written
            {
                return Err("插图名称、格式或大小无效".into());
            }
            export.parent.check()?;
            if dunce::canonicalize(&dir.path).map_err(err)? != dir.path {
                return Err("插图目录已改变".into());
            }
            let path = dir.path.join(name);
            let file = handles::create_image(&path).map_err(err)?;
            let mut entry = NewEntry {
                path,
                file,
                directory: false,
                keep: false,
            };
            entry.file.write_all(bytes).map_err(err)?;
            entry.file.sync_all().map_err(err)?;
            export.images.push(entry);
            export.bytes_written += bytes.len();
            Ok(())
        })();
        if result.is_err() {
            grants.remove(token);
        }
        result
    }
    fn finish(&self, token: &str, md: &[u8]) -> Result<()> {
        let parent = self.lock()?.get(token).ok_or(EXPIRED)?.parent.clone();
        let result = (|| {
            if md.len() > 64 * MIB || std::str::from_utf8(md).is_err() {
                return Err("Markdown 必须是有效 UTF-8，且不超过 64 MiB".into());
            }
            parent.check()?;
            let mut tmp = NamedTempFile::new_in(&parent.path).map_err(err)?;
            tmp.write_all(md).map_err(err)?;
            tmp.as_file().sync_all().map_err(err)?;
            // Cancellation can take the ticket while the bytes flush. Taking it here
            // is the commit point. persist_noclobber also guards a race at the final leaf.
            let mut export = self.lock()?.remove(token).ok_or(EXPIRED)?;
            parent.check()?;
            tmp.persist_noclobber(&export.target).map_err(|e| {
                if e.error.kind() == io::ErrorKind::AlreadyExists {
                    "目标已被创建，未覆盖，请另选名称".into()
                } else {
                    err(e.error)
                }
            })?;
            for entry in export.images.iter_mut().chain(export.directory.iter_mut()) {
                entry.keep = true;
            }
            Ok(())
        })();
        if result.is_err() {
            self.cancel(token)?;
        }
        result
    }
    fn cancel(&self, token: &str) -> Result<()> {
        self.lock()?.remove(token);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn choose_markdown_export(
    app: AppHandle,
    webview: WebviewWindow,
    name: String,
    include_images: bool,
) -> Result<Option<Ticket>> {
    trusted(&app, &webview)?;
    blocking(move || {
        let name = if markdown_leaf(&name) {
            &name
        } else {
            "Paperwork.md"
        };
        let Some(path) = dialog(&webview, "save", "导出 Markdown（仅创建新文件）")
            .add_filter("Markdown", &["md"])
            .set_file_name(name)
            .save_file()
        else {
            return Ok(None);
        };
        let ticket = app
            .state::<MarkdownExports>()
            .issue(&path, include_images)?;
        if let Some(dir) = path.parent() {
            app.state::<Database>().remember_picker("save", dir);
        }
        Ok(Some(ticket))
    })
    .await
}
fn token<'a>(req: &'a Request<'_>) -> Result<&'a str> {
    req.headers()
        .get("x-paperwork-ticket")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| EXPIRED.into())
}
fn raw<'a>(req: &'a Request<'_>) -> Result<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("请使用二进制传输".into()),
    }
}
#[tauri::command(async)]
pub(crate) fn write_markdown_asset(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<()> {
    trusted(&app, &webview)?;
    let name = request
        .headers()
        .get("x-paperwork-asset")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少插图文件名")?;
    app.state::<MarkdownExports>()
        .image(token(&request)?, name, raw(&request)?)
}
#[tauri::command(async)]
pub(crate) fn finish_markdown_export(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<()> {
    trusted(&app, &webview)?;
    app.state::<MarkdownExports>()
        .finish(token(&request)?, raw(&request)?)
}
#[tauri::command(async)]
pub(crate) fn cancel_markdown_export(
    app: AppHandle,
    webview: WebviewWindow,
    token: String,
) -> Result<()> {
    trusted(&app, &webview)?;
    app.state::<MarkdownExports>().cancel(&token)
}

#[cfg(test)]
#[path = "markdown_export_tests.rs"]
mod tests;
