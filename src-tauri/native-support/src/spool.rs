use super::{Res, MAX_BINARY, QUEUE_NAME};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
};

/// Accept only the queue's own fixed per-user port. A printer configuration pointing at
/// another user's files or a network share must never grant file access to the WebView.
pub fn configured_inbox(root: &Path) -> Result<Option<PathBuf>, String> {
    // The fixed Windows queue and its legacy Electron port belong to the production
    // application. Alternate application IDs must never enumerate or drain that port;
    // they may still process jobs explicitly staged in their own virtual-jobs directory.
    if !root.file_name().and_then(|s| s.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("studio.paperwork.pdf")) {
        return Ok(None);
    }
    let Some((driver, port)) = super::print::driver_port(QUEUE_NAME).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if !driver.eq_ignore_ascii_case("Microsoft Print To PDF") {
        return Ok(None);
    }
    let legacy = root.parent().map(|p| p.join(QUEUE_NAME));
    Ok(std::iter::once(root.to_owned())
        .chain(legacy)
        .map(|r| r.join("PrintInbox").join("PaperworkPrint.pdf"))
        .find(|p| {
            p.to_string_lossy()
                .replace('/', "\\")
                .eq_ignore_ascii_case(&port.replace('/', "\\"))
                && p.parent().is_some_and(Path::is_dir)
        }))
}
fn queue(root: &Path) -> PathBuf {
    root.join("virtual-jobs")
}
fn valid_id(s: &str) -> bool {
    let Some((ts, u)) = s.split_once('-') else {
        return false;
    };
    ts.len() >= 13
        && ts.len() <= 16
        && ts.bytes().all(|b| b.is_ascii_digit())
        && Uuid::try_parse(u).is_ok_and(|id| id.to_string() == u)
}
fn queued(root: &Path, id: &str) -> Res<PathBuf> {
    if !valid_id(id) {
        return Err("无效的打印任务编号".into());
    }
    Ok(queue(root).join(format!("{id}.pdf")))
}
fn no_reparse(md: &fs::Metadata) -> bool {
    md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}
fn exists_regular_parent(path: &Path) -> bool {
    path.parent()
        .and_then(|p| p.symlink_metadata().ok())
        .is_some_and(|md| md.is_dir() && no_reparse(&md))
}
/// The watcher supplies the validated app-owned path, not the renderer. Holding a no-write-share
/// file handle until the atomic move prevents accepting an intermediate PDF revision mid-write.
pub fn capture(root: &Path, inbox: &Path) -> Result<bool, String> {
    fn run(root: &Path, inbox: &Path) -> Res<bool> {
        if !exists_regular_parent(inbox) {
            return Ok(false);
        }
        let mut f = match OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(inbox)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(32) => {
                return Ok(false)
            }
            Err(e) => return Err(e.into()),
        };
        let md = f.metadata()?;
        if !md.is_file() || !no_reparse(&md) || md.len() < 10 {
            return Ok(false);
        }
        // Do not delete oversize jobs or mark them acknowledged. A reader can report a specific error.
        let mut magic = [0; 5];
        f.read_exact(&mut magic)?;
        if &magic != b"%PDF-" {
            return Ok(false);
        }
        f.seek(SeekFrom::End(-(md.len().min(2048) as i64)))?;
        let mut tail = Vec::new();
        f.read_to_end(&mut tail)?;
        if !tail.trim_ascii_end().ends_with(b"%%EOF") {
            return Ok(false);
        }
        fs::create_dir_all(queue(root))?;
        let name = format!(
            "{}-{}.pdf",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
            Uuid::new_v4()
        );
        let dest = queue(root).join(name);
        if !exists_regular_parent(&dest) {
            return Err("打印任务目录无效".into());
        }
        fs::rename(inbox, dest)?;
        Ok(true)
    }
    run(root, inbox).map_err(|e| e.to_string())
}
pub(super) fn pending(root: &Path, query: &Value) -> Res<Value> {
    // Page through *metadata*, not PDF bodies. A postponed first job must never
    // hide the second one; the picker may still re-open the first job later.
    let after = query.get("after").and_then(Value::as_str);
    if after.is_some_and(|id| !valid_id(id)) { return Err("打印收件箱游标无效".into()); }
    let limit = query.get("limit").and_then(Value::as_u64).unwrap_or(1).clamp(1,64) as usize;
    let dir = queue(root);
    if !dir.is_dir() {
        return Ok(json!([]));
    }
    let mut page = std::collections::BTreeSet::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|s| s.strip_suffix(".pdf")) else {
            continue;
        };
        if valid_id(id) && after.is_none_or(|a| id > a) {
            page.insert(id.to_string());
            if page.len() > limit { page.pop_last(); }
        }
    }
    Ok(Value::Array(page.into_iter().map(|id| {
        json!({"id":id,"name":format!("打印任务-{}.pdf",id.split('-').next().unwrap_or_default()),"path":"","type":"pdf"})
    }).collect()))
}
pub(super) fn bytes(root: &Path, id: &str) -> Res<Vec<u8>> {
    let p = queued(root, id)?;
    if !exists_regular_parent(&p) {
        return Err("打印任务目录无效".into());
    }
    let f = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(p)?;
    let md = f.metadata()?;
    if !no_reparse(&md) || !md.is_file() || md.len() > MAX_BINARY as u64 {
        return Err("打印任务无效或超过 128 MiB；文件已保留在任务队列中".into());
    }
    let mut out = Vec::new();
    f.take(MAX_BINARY as u64 + 1).read_to_end(&mut out)?;
    if out.len() > MAX_BINARY {
        return Err("打印任务过大".into());
    }
    Ok(out)
}
pub(super) fn ack(root: &Path, v: Value) -> Res<()> {
    let ids = v["ids"].as_array().ok_or("无效的打印任务编号")?;
    if ids.len() > 64 {
        return Err("任务过多".into());
    }
    let paths: Vec<_> = ids
        .iter()
        .map(|v| queued(root, v.as_str().unwrap_or_default()))
        .collect::<Res<_>>()?;
    for p in paths {
        if !exists_regular_parent(&p) {
            return Err("打印任务目录无效".into());
        }
        match fs::remove_file(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            r => r?,
        }
    }
    Ok(())
}
