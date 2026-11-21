//! Windows-only services for the local desktop WebView. Paths and database queries never come from IPC.
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

#[cfg(windows)]
mod ocr;
mod outlook_msg;
pub use outlook_msg::MAX_OUTLOOK_MSG_BYTES;
#[cfg(windows)]
mod print;
#[cfg(windows)]
mod spool;
mod store;
#[cfg(windows)]
pub use spool::{capture, configured_inbox};

type Failure = Box<dyn std::error::Error + Send + Sync>;
type Res<T> = Result<T, Failure>;
pub const MAX_BINARY: usize = 128 * 1024 * 1024;
const MAX_OCR_PIXELS: usize = 22_000_000;
const QUEUE_NAME: &str = "Paperwork PDF Studio";

#[derive(Deserialize)]
struct Id {
    id: String,
}
fn id(v: Value) -> Res<String> {
    let value = serde_json::from_value::<Id>(v)?.id;
    Ok(uuid::Uuid::parse_str(&value)
        .map_err(|_| "无效的记录标识")?
        .hyphenated()
        .to_string())
}

/// Dispatch a narrow JSON operation; `root` is resolved from Tauri's application data path.
pub fn feature(root: &Path, action: &str, payload: Value) -> Result<Value, String> {
    execute(root, action, payload).map_err(|error| error.to_string())
}
fn small_payload(v: &Value, budget: &mut usize, depth: usize) -> bool {
    if depth > 4 || *budget == 0 {
        return false;
    }
    *budget -= 1;
    match v {
        Value::String(s) => {
            if s.len() > *budget {
                return false;
            }
            *budget -= s.len();
            true
        }
        Value::Array(a) => a.len() <= 64 && a.iter().all(|v| small_payload(v, budget, depth + 1)),
        Value::Object(o) => {
            o.len() <= 16
                && o.iter()
                    .all(|(k, v)| k.len() <= 64 && small_payload(v, budget, depth + 1))
        }
        _ => true,
    }
}

fn execute(root: &Path, action: &str, payload: Value) -> Res<Value> {
    let mut budget = 32 * 1024;
    if action.len() > 64 || !small_payload(&payload, &mut budget, 0) {
        return Err("桌面操作参数超出限制".into());
    }
    match action {
        #[cfg(windows)]
        "getPrinters" => print::list(),
        #[cfg(windows)]
        "getOcrStatus" => Ok(ocr::status()),
        #[cfg(windows)]
        "getOcrCapabilities" => Ok(ocr::capabilities()),
        #[cfg(windows)]
        "testOcrConnection" => {
            if payload["provider"] == "local" {
                let status = ocr::status();
                Ok(
                    json!({"ok":status["available"],"message":if status["available"] == true {format!("{} 已就绪（离线）", status["model"].as_str().unwrap_or_default())} else {status["error"].as_str().unwrap_or("本地 OCR 不可用").into()}}),
                )
            } else {
                Ok(
                    json!({"ok":false,"message":"此原生版本使用离线 Windows OCR，未启用云端或自定义 OCR；未发送请求。"}),
                )
            }
        }
        #[cfg(windows)]
        "getVirtualPrinterStatus" => Ok(match configured_inbox(root) {
            Ok(inbox) => {
                json!({"supported":true,"installed":inbox.is_some(),"printerName":QUEUE_NAME})
            }
            Err(message) => {
                json!({"supported":true,"installed":false,"printerName":QUEUE_NAME,"error":message})
            }
        }),
        #[cfg(windows)]
        "takeVirtualPrintJobs" => spool::pending(root, &payload),
        #[cfg(windows)]
        "acknowledgeVirtualPrintJobs" => {
            spool::ack(root, payload)?;
            Ok(Value::Null)
        }
        "loadOcrSecrets"
        | "saveOcrSecrets"
        | "loadPdfPasswordHistory"
        | "rememberPdfPassword"
        | "removePdfPasswordHistoryEntry"
        | "clearPdfPasswordHistory"
        | "listElectronicSeals"
        | "importElectronicSeal"
        | "readElectronicSeal"
        | "updateElectronicSeal"
        | "deleteElectronicSeal" => store::execute(root, action, payload),
        _ => Err("当前平台不支持此桌面操作".into()),
    }
}

/// Raw transport avoids expanding each pixel into a JSON number. The small metadata header is separate.
pub fn binary(
    root: &Path,
    owner: usize,
    action: &str,
    meta: &str,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    fn inner(root: &Path, owner: usize, action: &str, meta: &str, data: &[u8]) -> Res<Vec<u8>> {
        if meta.len() > 1024 || data.len() > MAX_BINARY {
            return Err("任务超出大小限制，请分批处理".into());
        }
        match action {
            "parseOutlookMsg" if meta.is_empty() => {
                Ok(serde_json::to_vec(&outlook_msg::parse(data)?)?)
            }
            #[cfg(windows)]
            "ocr" => Ok(serde_json::to_vec(&ocr::recognize(meta, data)?)?),
            #[cfg(windows)]
            "print" => {
                print::print_packet(owner, data)?;
                Ok(b"true".to_vec())
            }
            #[cfg(windows)]
            "jobBytes" if data.is_empty() => spool::bytes(root, meta),
            "sealBytes" if data.is_empty() => store::bytes(root, &id(json!({"id":meta}))?),
            _ => Err("未知的桌面数据请求".into()),
        }
    }
    inner(root, owner, action, meta, data).map_err(|e| e.to_string())
}
