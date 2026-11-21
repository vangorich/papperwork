use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, Manager, WebviewWindow,
};

// Custom commands do not accept paths, SQL, URLs, executable names or shell text.
pub(crate) fn trusted(app: &AppHandle, view: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    let url = view.url().map_err(|e| e.to_string())?;
    let bundled = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    let dev = cfg!(debug_assertions)
        && app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|u| u.origin() == url.origin());
    if view.label() != "main" || !(bundled || dev) {
        return Err("仅允许本地工作台使用桌面服务".into());
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn native_feature(
    app: AppHandle,
    webview: WebviewWindow,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    let root = trusted(&app, &webview)?;
    tauri::async_runtime::spawn_blocking(move || native_support::feature(&root, &action, payload))
        .await
        .map_err(|e| e.to_string())?
}

static PAGE_BUSY: AtomicBool = AtomicBool::new(false);
struct PageGuard;
impl Drop for PageGuard {
    fn drop(&mut self) {
        PAGE_BUSY.store(false, Ordering::Release)
    }
}

#[tauri::command]
pub async fn native_binary(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<Response, String> {
    let root = trusted(&app, &webview)?;
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let action = header("x-native-action");
    let meta = header("x-native-meta");
    let data = match request.body() {
        InvokeBody::Raw(data) if data.len() <= native_support::MAX_BINARY => data,
        _ => return Err("无效的原生二进制请求或任务超过 128 MiB".into()),
    };
    let guard = match action.as_str() {
        "ocr" | "print" => {
            if PAGE_BUSY.swap(true, Ordering::AcqRel) {
                return Err("另一个页面处理任务正在进行，请稍后再试".into());
            }
            Some(PageGuard)
        }
        "parseOutlookMsg" if meta.is_empty() && !data.is_empty() && data.len() <= 32 * 1024 * 1024 => None,
        "parseOutlookMsg" => return Err("MSG 邮件为空或超过 32 MiB，未读取附件。".into()),
        "jobBytes" | "sealBytes" if data.is_empty() => None,
        _ => return Err("未知的数据操作".into()),
    };
    if meta.len() > 1024 {
        return Err("无效的任务参数".into());
    }
    #[cfg(windows)]
    let owner = webview.hwnd().map_err(|e| e.to_string())?.0 as usize;
    #[cfg(not(windows))]
    let owner = 0;
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        native_support::binary(&root, owner, &action, &meta, &data).map(Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn start_virtual_print_watcher(app: AppHandle) {
    #[cfg(windows)]
    {
        if app.config().identifier != "studio.paperwork.pdf" {
            // QA/alternate IDs can consume their own staged virtual-jobs, never a real spool port.
            eprintln!("Paperwork: external print watcher disabled for alternate app ID");
            return;
        }
        let Ok(root) = app.path().app_data_dir() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("paperwork-print-inbox".into())
            .spawn(move || {
                let mut active = false;
                loop {
                    let inbox = native_support::configured_inbox(&root).ok().flatten();
                    if active != inbox.is_some() {
                        active = inbox.is_some();
                        crate::set_printer_active(&app, active)
                    }
                    if let Some(path) = inbox {
                        // Revalidate the port periodically, but use only the fixed, app-owned path between checks.
                        for _ in 0..30 {
                            if native_support::capture(&root, &path).unwrap_or(false) {
                                let _ = app.emit("native-virtual-print-job", ());
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                    } else {
                        std::thread::sleep(std::time::Duration::from_secs(30))
                    }
                }
            });
    }
    #[cfg(not(windows))]
    let _ = app;
}
