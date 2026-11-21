use crate::database::Database;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager, WebviewWindow,
};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const CHUNK: usize = 16 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn ext(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
pub(crate) fn supported(path: &Path) -> bool {
    matches!(
        ext(path).as_str(),
        "pdf" | "ofd" | "msg" | "png" | "jpg" | "jpeg" | "doc" | "docx"
    )
}
fn parent(p: &Path) -> Result<&Path> {
    p.parent().ok_or_else(|| "文件没有有效的上级目录".into())
}
fn iso(t: std::io::Result<SystemTime>) -> Option<String> {
    t.ok().map(|v| DateTime::<Utc>::from(v).to_rfc3339())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    token: String,
    path: String,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
    created_at: Option<String>,
    modified_at: Option<String>,
    accessed_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
}
impl Stamp {
    fn from(m: &fs::Metadata) -> Self {
        Self {
            size: m.len(),
            modified: m.modified().ok(),
        }
    }
}

struct Grant {
    file: PathBuf,
    stamp: Stamp,
    // A converted Word document can be read, never revealed/overwritten as its original.
    temporary: Option<TempDir>,
}
impl Grant {
    fn check(&self) -> Result<File> {
        if dunce::canonicalize(&self.file).map_err(err)? != self.file {
            return Err("原文件位置已改变，请重新打开".into());
        }
        let f = File::open(&self.file).map_err(err)?;
        if Stamp::from(&f.metadata().map_err(err)?) != self.stamp {
            return Err("文件已被其他程序修改。请重新打开，或将更改另存为新文件。".into());
        }
        Ok(f)
    }

    fn read_range(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        if length > CHUNK || offset > self.stamp.size || length as u64 > self.stamp.size - offset {
            return Err("读取范围无效".into());
        }
        let mut file = self.check()?;
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(err)?;
        if Stamp::from(&file.metadata().map_err(err)?) != self.stamp {
            return Err("读取时文件被修改，请重新打开".into());
        }
        Ok(bytes)
    }
}

#[derive(Clone)]
struct WriteTarget {
    path: PathBuf,
    original: Option<Stamp>,
}
#[derive(Default)]
struct Grants {
    documents: HashMap<String, Arc<Grant>>,
    writes: HashMap<String, WriteTarget>,
}
#[derive(Default)]
pub(crate) struct Files(Mutex<Grants>);
impl Files {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Grants>> {
        self.0
            .lock()
            .map_err(|_| "文件授权已失效，请重新启动应用".into())
    }
    fn grant(&self, token: &str) -> Result<Arc<Grant>> {
        self.lock()?
            .documents
            .get(token)
            .cloned()
            .ok_or_else(|| "该文件未经选择或授权已失效，请重新打开".into())
    }

    fn describe(&self, source: &Path, allow_word: bool) -> Result<Document> {
        let source = dunce::canonicalize(source).map_err(err)?;
        let info = fs::metadata(&source).map_err(err)?;
        if !info.is_file() {
            return Err("请选择普通文件".into());
        }
        let extension = ext(&source);
        let name = source
            .file_name()
            .ok_or("文件名无效")?
            .to_string_lossy()
            .into_owned();
        let (file, name, kind, temporary) = match extension.as_str() {
            "pdf" => (source.clone(), name, "pdf", None),
            "ofd" => (source.clone(), name, "ofd", None),
            "msg" => {
                // Check length before granting a read or allocating mail bytes in JS.
                if info.len() == 0 || info.len() > 32 * 1024 * 1024 { return Err("MSG 邮件为空或超过 32 MiB，未打开。".into()); }
                (source.clone(), name, "msg", None)
            },
            "png" | "jpg" | "jpeg" => (source.clone(), name, "image", None),
            "doc" | "docx" if allow_word => {
                let temp = convert_word(&source)?;
                let file = dunce::canonicalize(temp.path().join("converted.pdf")).map_err(err)?;
                let name = source
                    .with_extension("pdf")
                    .file_name()
                    .ok_or("文件名无效")?
                    .to_string_lossy()
                    .into_owned();
                (file, name, "pdf", Some(temp))
            }
            _ => return Err("不支持此文档格式".into()),
        };
        let stamp = Stamp::from(&fs::metadata(&file).map_err(err)?);
        let doc = Document {
            token: id(),
            path: if temporary.is_some() {
                String::new()
            } else {
                source.to_string_lossy().into_owned()
            },
            name,
            kind,
            size: stamp.size,
            created_at: iso(info.created()),
            modified_at: iso(info.modified()),
            accessed_at: iso(info.accessed()),
        };
        self.lock()?.documents.insert(
            doc.token.clone(),
            Arc::new(Grant {
                file,
                stamp,
                temporary,
            }),
        );
        Ok(doc)
    }

    fn ticket(&self, target: WriteTarget) -> Result<Ticket> {
        let t = Ticket {
            token: id(),
            path: target.path.to_string_lossy().into_owned(),
        };
        self.lock()?.writes.insert(t.token.clone(), target);
        Ok(t)
    }
}

// Word is optional, never a bundled interpreter. Only a selected Word file may reach this
// fixed conversion command. Disable document macros, external link updates and prompts.
#[cfg(windows)]
fn convert_word(path: &Path) -> Result<TempDir> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; $word=$null; $doc=$null; try { $word=New-Object -ComObject Word.Application; $word.AutomationSecurity=3; $word.Visible=$false; $word.DisplayAlerts=0; $word.Options.UpdateLinksAtOpen=$false; $doc=$word.Documents.Open($env:PAPERWORK_WORD_INPUT,$false,$true,$false); $doc.ExportAsFixedFormat($env:PAPERWORK_WORD_OUTPUT,17) } finally { if ($doc) { $doc.Close([ref]$false) }; if ($word) { $word.Quit() } }"#;
    let dir = tempfile::tempdir().map_err(err)?;
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法找到系统组件")?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ])
        .env("PAPERWORK_WORD_INPUT", path)
        .env("PAPERWORK_WORD_OUTPUT", dir.path().join("converted.pdf"))
        .current_dir(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().map_err(err)? {
            return if status.success() && dir.path().join("converted.pdf").is_file() {
                Ok(dir)
            } else {
                Err("无法转换 Word 文档。请确认已安装桌面版 Microsoft Word，且源文档未被占用或加密。".into())
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Word 转换超时，原文件未修改".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
#[cfg(not(windows))]
fn convert_word(_: &Path) -> Result<TempDir> {
    Err("此平台不支持 Microsoft Word 转换，请先将文档导出为 PDF".into())
}

pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Picker {
    Open,
    Folder,
    Print,
    PrintFolder,
}
pub(crate) fn dialog(window: &WebviewWindow, purpose: &str, title: &str) -> rfd::FileDialog {
    let d = rfd::FileDialog::new().set_parent(window).set_title(title);
    if let Some(p) = window.state::<Database>().picker(purpose) {
        d.set_directory(p)
    } else {
        d
    }
}
fn in_folder(folder: &Path, print: bool) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(folder).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        let extension = ext(&path);
        if entry.file_type().map_err(err)?.is_file()
            && (extension == "pdf"
                || (!print && matches!(extension.as_str(), "ofd" | "msg" | "png" | "jpg" | "jpeg")))
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

#[tauri::command]
pub(crate) async fn pick_documents(
    window: WebviewWindow,
    mode: Picker,
    pdf_only: Option<bool>,
    images: bool,
    documents: bool,
    multiple: bool,
) -> Result<Vec<Document>> {
    blocking(move || {
        let print = matches!(mode, Picker::Print | Picker::PrintFolder);
        let folder = matches!(mode, Picker::Folder | Picker::PrintFolder);
        let purpose = if folder { "folder" } else { "open" };
        let d = dialog(
            &window,
            purpose,
            if folder {
                "选择文档文件夹"
            } else {
                "打开文档"
            },
        );
        let db = window.state::<Database>();
        let paths = if folder {
            let Some(dir) = d.pick_folder() else {
                return Ok(vec![]);
            };
            db.remember_picker(purpose, &dir);
            in_folder(&dir, print)?
        } else {
            let mut extensions = vec!["pdf"];
            if !print && !pdf_only.unwrap_or(false) {
                extensions.extend(["ofd", "msg"]);
                if images {
                    extensions.extend(["png", "jpg", "jpeg"]);
                }
                if documents {
                    extensions.extend(["doc", "docx"]);
                }
            }
            let d = d.add_filter(
                if print || pdf_only.unwrap_or(false) {
                    "PDF 文档"
                } else {
                    "支持的文档"
                },
                &extensions,
            );
            let paths: Vec<_> = if multiple {
                d.pick_files().unwrap_or_default()
            } else {
                d.pick_file().into_iter().collect()
            };
            if let Some(dir) = paths.first().and_then(|p| p.parent()) {
                db.remember_picker(purpose, dir);
            }
            if paths.iter().any(|p| !extensions.contains(&ext(p).as_str())) {
                return Err("所选文件不符合当前格式".into());
            }
            paths
        };
        let grants = window.state::<Files>();
        paths
            .iter()
            .map(|p| grants.describe(p, documents && !print))
            .collect()
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_granted(
    app: AppHandle,
    token: String,
    offset: u64,
    length: usize,
) -> Result<Response> {
    let grant = app.state::<Files>().grant(&token)?;
    blocking(move || Ok(Response::new(grant.read_range(offset, length)?))).await
}

#[tauri::command]
pub(crate) fn release_document(state: tauri::State<'_, Files>, token: String) -> Result<()> {
    state.lock()?.documents.remove(&token);
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct Ticket {
    token: String,
    path: String,
}
#[derive(Serialize)]
pub(crate) struct Batch {
    directory: String,
    tickets: Vec<Ticket>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Format {
    Pdf,
    Png,
    Jpeg,
    Docx,
}
impl Format {
    fn extensions(&self) -> &'static [&'static str] {
        match self {
            Self::Pdf => &["pdf"],
            Self::Png => &["png"],
            Self::Jpeg => &["jpg", "jpeg"],
            Self::Docx => &["docx"],
        }
    }
}

pub(crate) fn safe_leaf(name: &str) -> bool {
    if name.is_empty()
        || name.encode_utf16().count() > 250
        || name.starts_with(' ')
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) {
        return false;
    }
    !["COM", "LPT"].iter().any(|p| {
        stem.strip_prefix(p).is_some_and(|n| {
            n.len() == 1 && n.as_bytes()[0].is_ascii_digit() || matches!(n, "¹" | "²" | "³")
        })
    })
}
fn suggested(name: &str, format: &Format) -> String {
    let extensions = format.extensions();
    let p = Path::new(name);
    if !safe_leaf(name) {
        return format!("Paperwork-export.{}", extensions[0]);
    }
    if extensions.contains(&ext(p).as_str()) {
        name.to_owned()
    } else {
        p.with_extension(extensions[0])
            .to_string_lossy()
            .into_owned()
    }
}
fn proposed(path: &Path, replace: bool) -> Result<WriteTarget> {
    let leaf = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| safe_leaf(s))
        .ok_or("文件名不安全")?;
    let path = dunce::canonicalize(parent(path)?).map_err(err)?.join(leaf);
    let original = match fs::symlink_metadata(&path) {
        Ok(m)
            if m.file_type().is_file()
                && replace
                && dunce::canonicalize(&path).map_err(err)? == path =>
        {
            Some(Stamp::from(&m))
        }
        Ok(_) => {
            return Err(format!(
                "目标已存在或不是普通文件：{leaf}。请选择其他名称或空文件夹。"
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(err(e)),
    };
    Ok(WriteTarget { path, original })
}

#[tauri::command]
pub(crate) async fn choose_save(
    window: WebviewWindow,
    name: String,
    format: Format,
    create_only: Option<bool>,
) -> Result<Option<Ticket>> {
    blocking(move || {
        let new_copy = create_only.unwrap_or(false);
        let extensions = format.extensions();
        let d = dialog(&window, "save", if new_copy { "另存为新副本（不能替换已有文件）" } else { "保存文件" })
            .add_filter(extensions[0].to_ascii_uppercase(), extensions)
            .set_file_name(suggested(&name, &format));
        let Some(path) = d.save_file() else {
            return Ok(None);
        };
        if !extensions.contains(&ext(&path).as_str()) {
            return Err("文件扩展名与导出格式不符".into());
        }
        let target = proposed(&path, !new_copy)?;
        window
            .state::<Database>()
            .remember_picker("save", parent(&path)?);
        window.state::<Files>().ticket(target).map(Some)
    })
    .await
}

#[tauri::command]
pub(crate) async fn choose_save_many(
    window: WebviewWindow,
    names: Vec<String>,
) -> Result<Option<Batch>> {
    blocking(move || {
        if names.is_empty() || names.len() > 8192 {
            return Err("批量导出文件数量无效".into());
        }
        let mut seen = HashSet::new();
        for n in &names {
            if !safe_leaf(n)
                || !matches!(
                    ext(Path::new(n)).as_str(),
                    "pdf" | "jpg" | "jpeg" | "png" | "docx"
                )
                || !seen.insert(n.to_lowercase())
            {
                return Err(format!("重复或不安全的导出文件名：{n}"));
            }
        }
        let Some(dir) = dialog(&window, "save", "选择导出文件夹（不会覆盖已有文件）").pick_folder()
        else {
            return Ok(None);
        };
        let dir = dunce::canonicalize(dir).map_err(err)?;
        let targets = names
            .iter()
            .map(|n| proposed(&dir.join(n), false))
            .collect::<Result<Vec<_>>>()?;
        let grants = window.state::<Files>();
        let tickets = targets
            .into_iter()
            .map(|t| grants.ticket(t))
            .collect::<Result<Vec<_>>>()?;
        window.state::<Database>().remember_picker("save", &dir);
        Ok(Some(Batch {
            directory: dir.to_string_lossy().into_owned(),
            tickets,
        }))
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_overwrite(app: AppHandle, token: String) -> Result<Ticket> {
    blocking(move || {
        let files = app.state::<Files>();
        let g = files.grant(&token)?;
        if g.temporary.is_some() || ext(&g.file) != "pdf" {
            return Err("只能覆盖已打开的 PDF 原件".into());
        }
        g.check()?;
        files.ticket(WriteTarget {
            path: g.file.clone(),
            original: Some(g.stamp),
        })
    })
    .await
}

fn persist(target: &WriteTarget, bytes: &[u8]) -> Result<()> {
    let dir = parent(&target.path)?;
    if dunce::canonicalize(dir).map_err(err)? != dir {
        return Err("保存目录已改变，请重新选择".into());
    }
    let mut tmp = NamedTempFile::new_in(dir).map_err(err)?;
    tmp.write_all(bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    if let Some(previous) = target.original {
        let meta = fs::symlink_metadata(&target.path).map_err(err)?;
        if !meta.file_type().is_file()
            || dunce::canonicalize(&target.path).map_err(err)? != target.path
            || Stamp::from(&meta) != previous
        {
            return Err("目标文件已改变，未覆盖。请另存为新文件。".into());
        }
        tmp.persist(&target.path).map_err(err)?;
    } else {
        tmp.persist_noclobber(&target.path).map_err(err)?;
    }
    Ok(())
}

// Tauri owns the HTTP body for the duration of this worker command. Borrow its raw bytes
// directly instead of allocating an additional full PDF, JSON number array or base64 string.
#[tauri::command(async)]
pub(crate) fn write_granted(
    state: tauri::State<'_, Files>,
    request: Request<'_>,
) -> Result<Option<Document>> {
    let token = request
        .headers()
        .get("x-paperwork-ticket")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少保存授权")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("文件必须以二进制传输".into());
    };
    let target = state
        .lock()?
        .writes
        .remove(token)
        .ok_or("保存授权无效或已使用")?;
    persist(&target, bytes)?;
    if ext(&target.path) == "pdf" {
        state.describe(&target.path, false).map(Some)
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub(crate) fn cancel_writes(state: tauri::State<'_, Files>, tokens: Vec<String>) -> Result<()> {
    let mut g = state.lock()?;
    for token in tokens {
        g.writes.remove(&token);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn reveal_document(app: AppHandle, token: String) -> Result<bool> {
    blocking(move || {
        let g = app.state::<Files>().grant(&token)?;
        if g.temporary.is_some()
            || !g.file.is_file()
            || dunce::canonicalize(&g.file).map_err(err)? != g.file
        {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let explorer = PathBuf::from(std::env::var_os("SystemRoot").ok_or("找不到资源管理器")?)
                .join("explorer.exe");
            // File names cannot contain a double quote on Windows. Explorer requires one /select, argument.
            std::process::Command::new(explorer)
                .raw_arg(format!("/select,\"{}\"", g.file.display()))
                .spawn()
                .map_err(err)?;
        }
        #[cfg(not(windows))]
        open::that(parent(&g.file)?).map_err(err)?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_external(url: String) -> Result<bool> {
    blocking(move || {
        let Ok(url) = tauri::Url::parse(&url) else {
            return Ok(false);
        };
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Ok(false);
        }
        open::that(url.as_str()).map_err(err)?;
        Ok(true)
    })
    .await
}

pub(crate) fn open_paths(app: &AppHandle, paths: &[PathBuf]) -> Result<Vec<Document>> {
    let files = app.state::<Files>();
    let mut docs = Vec::new();
    for path in paths {
        if path.is_dir() {
            for file in in_folder(path, false)? {
                docs.push(files.describe(&file, false)?);
            }
        } else if supported(path) {
            docs.push(files.describe(path, true)?);
        }
    }
    Ok(docs)
}
pub(crate) fn open_one(app: &AppHandle, path: &Path) -> Result<Document> {
    app.state::<Files>().describe(path, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_names_cannot_escape_or_address_windows_devices() {
        for n in [
            "../bad.pdf",
            "D:\\bad.pdf",
            "NUL.pdf",
            "aux .pdf",
            "a.pdf:stream",
            "LPT¹.pdf",
            "a/.pdf",
            "two.pdf ",
            "..",
            "foo\n.pdf",
        ] {
            assert!(!safe_leaf(n), "{n}");
        }
        assert!(safe_leaf("附件 01（修订）.pdf"));
        assert_eq!(
            suggested("../../wrong.exe", &Format::Pdf),
            "Paperwork-export.pdf"
        );
    }
    #[test]
    fn browse_folder_includes_ofd_and_images_but_print_folder_only_authorizes_pdfs() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.PDF", "b.ofd", "c.JPEG", "d.exe", "e.docx", "f.MSG"] {
            fs::write(dir.path().join(name), b"fixture").unwrap();
        }
        fs::create_dir(dir.path().join("not-a-file.pdf")).unwrap();
        let files = in_folder(dir.path(), false).unwrap();
        assert_eq!(
            files.iter().map(|p| ext(p)).collect::<Vec<_>>(),
            ["pdf", "ofd", "jpeg", "msg"]
        );
        assert_eq!(
            in_folder(dir.path(), true).unwrap(),
            [dir.path().join("a.PDF")]
        );
    }

    #[test]
    fn bounded_binary_reads_preserve_offsets_and_reject_invalid_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        let mut f = File::create(&path).unwrap();
        f.set_len(CHUNK as u64 + 4).unwrap();
        f.seek(SeekFrom::End(-4)).unwrap();
        f.write_all(&[0, 255, 128, 7]).unwrap();
        drop(f);
        let files = Files::default();
        let doc = files.describe(&path, false).unwrap();
        let grant = files.grant(&doc.token).unwrap();
        assert_eq!(grant.read_range(CHUNK as u64, 4).unwrap(), [0, 255, 128, 7]);
        assert!(grant.read_range(0, CHUNK + 1).is_err());
        assert!(grant.read_range(u64::MAX, 0).is_err());
        assert!(grant.read_range(doc.size, 1).is_err());
        assert!(grant.read_range(doc.size, 0).unwrap().is_empty());
    }

    #[test]
    fn file_grants_reject_paths_and_atomic_save_respects_changed_originals() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.pdf");
        fs::write(&p, b"old").unwrap();
        let grants = Files::default();
        let doc = grants.describe(&p, false).unwrap();
        assert!(grants.grant(p.to_str().unwrap()).is_err());
        assert!(grants.grant(&doc.token).unwrap().check().is_ok());
        let target = proposed(&p, true).unwrap();
        fs::write(&p, b"externally changed").unwrap();
        assert!(persist(&target, b"bad").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"externally changed");
        assert!(grants.grant(&doc.token).unwrap().check().is_err());
        let p = d.path().join("b.pdf");
        let fresh = proposed(&p, false).unwrap();
        fs::write(&p, b"racer").unwrap();
        assert!(persist(&fresh, b"do not replace").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"racer");
        persist(&proposed(&p, true).unwrap(), b"committed").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"committed");
    }
}
