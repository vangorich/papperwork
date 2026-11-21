#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;
mod documents;
mod lifecycle;
mod native_features;
mod pdf_mcp;
mod markdown_export;
mod markdown_assist;

fn context() -> tauri::Context<tauri::Wry> { tauri::generate_context!() }

pub(crate) use lifecycle::set_printer_active;
use std::path::{Path, PathBuf};
use tauri::{Listener, Manager};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Register state before the single-instance callback can deliver a second launch.
    let app = tauri::Builder::default()
        .manage(lifecycle::Session::default())
        .manage(documents::Files::default())
        .manage(pdf_mcp::Broker::default())
        .manage(markdown_export::MarkdownExports::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            lifecycle::reveal(app);
            lifecycle::enqueue(
                app,
                args.into_iter().skip(1).map(PathBuf::from),
                Path::new(&cwd),
            );
        }))
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("local-editor")
                .on_navigation(|_, url| {
                    matches!(
                        (url.scheme(), url.host_str(), url.port()),
                        ("tauri", Some("localhost"), None)
                            | ("http" | "https", Some("tauri.localhost"), None)
                    ) || (cfg!(debug_assertions)
                        && url.scheme() == "http"
                        && url.host_str() == Some("localhost")
                        && url.port() == Some(5173))
                })
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(database::Database::open(&dir.join("workspace.sqlite3"))?);
            pdf_mcp::start(app.handle().clone(), dir);
            let window = app.get_webview_window("main").ok_or("缺少主窗口")?;
            lifecycle::restore(&window);
            lifecycle::enqueue(
                app.handle(),
                std::env::args_os().skip(1).map(PathBuf::from),
                &std::env::current_dir()?,
            );
            window.show()?;
            let handle = app.handle().clone();
            app.listen("native-virtual-print-job", move |_| {
                lifecycle::reveal(&handle)
            });
            native_features::start_virtual_print_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(lifecycle::window_event)
        .invoke_handler(tauri::generate_handler![
            documents::pick_documents,
            documents::read_granted,
            documents::release_document,
            documents::choose_save,
            documents::choose_save_many,
            documents::prepare_overwrite,
            documents::write_granted,
            documents::cancel_writes,
            documents::reveal_document,
            documents::open_external,
            lifecycle::take_pending_opens,
            lifecycle::acknowledge_open,
            lifecycle::claim_open,
            lifecycle::workspace_dirty,
            lifecycle::decide_close,
            lifecycle::session_reset_done,
            native_features::native_feature,
            native_features::native_binary,
            pdf_mcp::pdf_mcp_live,
            pdf_mcp::pdf_mcp_reply,
            markdown_export::choose_markdown_export,
            markdown_export::write_markdown_asset,
            markdown_export::finish_markdown_export,
            markdown_export::cancel_markdown_export,
            markdown_assist::assist_markdown,
            markdown_assist::cancel_markdown_assist,
        ])
        .build(context())?;
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            lifecycle::enqueue(
                handle,
                urls.into_iter().filter_map(|u| u.to_file_path().ok()),
                Path::new("/"),
            );
            lifecycle::reveal(handle);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
    Ok(())
}

fn main() {
    // Select stdio mode before single-instance or any GUI initialization. Never launch
    // the normal application or show an error dialog on an MCP client's pipes.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--pdf-mcp")) {
        let Some(roaming)=std::env::var_os("APPDATA") else { std::process::exit(2) };
        if let Err(e)=pdf_mcp::serve(&PathBuf::from(roaming).join(&context().config().identifier)) {
            eprintln!("Paperwork MCP: {e}"); std::process::exit(1);
        }
        return;
    }
    if let Err(e) = run() {
        eprintln!("Paperwork PDF Studio: {e}");
        rfd::MessageDialog::new()
            .set_title("Paperwork 无法启动")
            .set_description(format!("{e}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        std::process::exit(1);
    }
}
