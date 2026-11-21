use crate::{
    database::{Bounds, Database},
    documents,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering::SeqCst},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window, WindowEvent};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub(crate) struct OpenRequest {
    path: PathBuf,
    token: String,
    #[serde(skip)]
    acknowledged: bool,
}
#[derive(Default)]
pub(crate) struct Session {
    opens: Mutex<VecDeque<OpenRequest>>,
    pub ready: AtomicBool,
    dirty: AtomicBool,
    asking: AtomicBool,
    parking: AtomicBool,
    quit: AtomicBool,
    printer: AtomicBool,
}

pub(crate) fn enqueue(app: &AppHandle, values: impl IntoIterator<Item = PathBuf>, cwd: &Path) {
    let session = app.state::<Session>();
    if let Ok(mut queue) = session.opens.lock() {
        for value in values {
            if !documents::supported(&value) || value.as_os_str().to_string_lossy().starts_with('-')
            {
                continue;
            }
            queue.push_back(OpenRequest {
                path: cwd.join(value),
                token: Uuid::new_v4().to_string(),
                acknowledged: false,
            });
        }
    }
    let _ = app.emit_to("main", "paperwork-open-available", ());
}
#[tauri::command]
pub(crate) fn take_pending_opens(
    session: tauri::State<'_, Session>,
) -> Result<Vec<OpenRequest>, String> {
    session.ready.store(true, SeqCst);
    Ok(session
        .opens
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|o| !o.acknowledged)
        .cloned()
        .collect())
}
#[tauri::command]
pub(crate) fn acknowledge_open(
    session: tauri::State<'_, Session>,
    token: String,
) -> Result<(), String> {
    if let Some(o) = session
        .opens
        .lock()
        .map_err(|e| e.to_string())?
        .iter_mut()
        .find(|o| o.token == token)
    {
        o.acknowledged = true;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn claim_open(
    app: AppHandle,
    token: String,
) -> Result<documents::Document, String> {
    let path = {
        let session = app.state::<Session>();
        let mut q = session.opens.lock().map_err(|e| e.to_string())?;
        let i = q
            .iter()
            .position(|o| o.token == token)
            .ok_or("打开请求无效或已使用")?;
        q.remove(i).ok_or("打开请求已失效")?.path
    };
    documents::blocking(move || documents::open_one(&app, &path)).await
}

pub(crate) fn restore(window: &WebviewWindow) {
    let db = window.state::<Database>();
    let b = db.bounds();
    // Clamp both first launch and restored windows to a connected monitor's *work area*.
    let screens = window.available_monitors().unwrap_or_default();
    let saved_screen = b.as_ref().and_then(|b| {
        let (x, y) = (b.x?, b.y?);
        screens.iter().find(|m| {
            let a = m.work_area();
            x >= a.position.x
                && y >= a.position.y
                && i64::from(x) < i64::from(a.position.x) + i64::from(a.size.width)
                && i64::from(y) < i64::from(a.position.y) + i64::from(a.size.height)
        })
    });
    let primary = window.primary_monitor().ok().flatten();
    if let Some(m) = saved_screen.or(primary.as_ref()) {
        let a = m.work_area();
        let size = if let Some(b) = &b {
            tauri::PhysicalSize::new(b.width.min(a.size.width), b.height.min(a.size.height))
        } else {
            let s = window.inner_size().unwrap_or(a.size);
            tauri::PhysicalSize::new(s.width.min(a.size.width), s.height.min(a.size.height))
        };
        let _ = window.set_size(size);
        let (x, y) = if let Some(b) = &b {
            if saved_screen.is_some() {
                (b.x.unwrap_or(a.position.x), b.y.unwrap_or(a.position.y))
            } else {
                (a.position.x, a.position.y)
            }
        } else {
            (
                a.position.x + ((a.size.width - size.width) / 2) as i32,
                a.position.y + ((a.size.height - size.height) / 2) as i32,
            )
        };
        let x = x.clamp(
            a.position.x,
            a.position
                .x
                .saturating_add((a.size.width - size.width) as i32),
        );
        let y = y.clamp(
            a.position.y,
            a.position
                .y
                .saturating_add((a.size.height - size.height) as i32),
        );
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    if b.is_some_and(|b| b.maximized) {
        let _ = window.maximize();
    }
}
fn remember(window: &Window) {
    let db = window.state::<Database>();
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let b = if maximized {
        let mut previous = db.bounds().unwrap_or(Bounds {
            x: None,
            y: None,
            width: 1200,
            height: 800,
            maximized,
        });
        previous.maximized = true;
        previous
    } else {
        Bounds {
            x: Some(pos.x),
            y: Some(pos.y),
            width: size.width,
            height: size.height,
            maximized,
        }
    };
    db.remember_bounds(&b);
}

pub(crate) fn reveal(app: &AppHandle) {
    app.state::<Session>().parking.store(false, SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub(crate) fn window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            remember(window);
            let s = window.state::<Session>();
            if !s.ready.load(SeqCst) && !s.dirty.load(SeqCst) {
                return;
            }
            // Every close (including Alt+F4/tray Quit) asks the renderer: a just-edited
            // document may be dirty before the asynchronous mirror IPC has arrived.
            api.prevent_close();
            // React ignores repeats once its prompt is visible. Retrying on a second
            // gesture also recovers from an event lost during renderer reload/remount.
            s.asking.store(true, SeqCst);
            let _ = window.show();
            let _ = window.unminimize();
            if window
                .emit_to("main", "paperwork-close-request", ())
                .is_err()
            {
                s.asking.store(false, SeqCst);
            }
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => {
            let app = window.app_handle().clone();
            let paths = paths.clone();
            let scale = window.scale_factor().unwrap_or(1.0);
            let (x, y) = (position.x / scale, position.y / scale);
            tauri::async_runtime::spawn_blocking(move || {
                match documents::open_paths(&app, &paths) {
                    Ok(files) if !files.is_empty() => {
                        let _ = app.emit_to(
                            "main",
                            "paperwork-drop",
                            serde_json::json!({"files": files, "x": x, "y": y}),
                        );
                    }
                    Ok(_) => {
                        let _ = app.emit_to(
                            "main",
                            "paperwork-file-error",
                            "没有可打开的 PDF、OFD、图片或 Word 文档",
                        );
                    }
                    Err(message) => {
                        let _ = app.emit_to("main", "paperwork-file-error", message);
                    }
                }
            });
        }
        _ => (),
    }
}

#[tauri::command]
pub(crate) fn workspace_dirty(session: tauri::State<'_, Session>, dirty: bool) {
    session.dirty.store(dirty, SeqCst);
}
#[tauri::command]
pub(crate) fn decide_close(window: WebviewWindow, proceed: bool) -> Result<(), String> {
    let s = window.state::<Session>();
    if !s.asking.swap(false, SeqCst) {
        return Ok(());
    }
    if !proceed {
        s.quit.store(false, SeqCst);
        return Ok(());
    }
    if !s.quit.load(SeqCst) && s.printer.load(SeqCst) {
        s.parking.store(true, SeqCst);
        window
            .emit_to("main", "paperwork-session-reset", ())
            .map_err(|e| e.to_string())
    } else {
        window.destroy().map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub(crate) fn session_reset_done(window: WebviewWindow) -> Result<(), String> {
    if window.state::<Session>().parking.swap(false, SeqCst) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn set_printer_active(app: &AppHandle, active: bool) {
    use tauri::{
        menu::MenuBuilder,
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let state = app.state::<Session>();
    if !active {
        state.printer.store(false, SeqCst);
        if let Some(t) = app.tray_by_id("printer") {
            let _ = t.set_visible(false);
        }
        if app
            .get_webview_window("main")
            .is_some_and(|w| !w.is_visible().unwrap_or(true))
        {
            reveal(app);
        }
        return;
    }
    let result: tauri::Result<()> = (|| {
        if let Some(t) = app.tray_by_id("printer") {
            t.set_visible(true)?;
            return Ok(());
        }
        let menu = MenuBuilder::new(app)
            .text("show", "打开 Paperwork")
            .separator()
            .text("quit", "退出应用")
            .build()?;
        let mut tray = TrayIconBuilder::with_id("printer")
            .tooltip("Paperwork · 虚拟打印机正在监听")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    reveal(tray.app_handle());
                }
            })
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => reveal(app),
                "quit" => {
                    app.state::<Session>().quit.store(true, SeqCst);
                    reveal(app);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.close();
                    }
                }
                _ => (),
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
        Ok(())
    })();
    state.printer.store(result.is_ok(), SeqCst); // No tray icon => never hide an unreachable window.
    if let Err(e) = result {
        eprintln!("无法创建托盘图标：{e}");
    }
}
