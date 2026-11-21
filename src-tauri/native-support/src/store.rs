use super::{id, Res};
use image::{ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};
use uuid::Uuid;

#[cfg(test)]
mod tests;

const SEAL_LIMIT: usize = 25 * 1024 * 1024;
fn db(root: &Path) -> Res<Connection> {
    fs::create_dir_all(root)?;
    let conn = Connection::open(root.join("native-features.sqlite3"))?;
    conn.busy_timeout(Duration::from_secs(4))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS vault (key TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS seals (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, updated TEXT NOT NULL, meta TEXT NOT NULL, image BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS seals_updated ON seals(updated DESC);
      COMMIT;")?;
    Ok(conn)
}
fn now(conn: &Connection) -> Res<String> {
    Ok(
        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })?,
    )
}

#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> Res<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    if input.is_empty() || input.len() > 512 * 1024 {
        return Err("凭据长度无效".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input is a borrowed initialized buffer. DPAPI allocates the result and
    // LocalFree releases it exactly once; scope is the signed-in user, never the machine.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "无法使用当前 Windows 用户保护或解锁凭据：{}",
                std::io::Error::last_os_error()
            )
            .into());
        }
        if out.pbData.is_null() {
            return Err("Windows 返回空的凭据数据".into());
        }
        let slice = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
        let bytes = slice.to_vec();
        if !encrypt {
            slice.fill(0)
        }
        LocalFree(out.pbData.cast());
        Ok(bytes)
    }
}
#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Res<Vec<u8>> {
    Err("此平台未提供 Windows DPAPI，拒绝明文存储".into())
}
fn vault_read<T: serde::de::DeserializeOwned + Default>(c: &Connection, key: &str) -> Res<T> {
    let ciphertext: Option<Vec<u8>> = c
        .query_row("SELECT ciphertext FROM vault WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    match ciphertext {
        Some(data) => Ok(serde_json::from_slice(&dpapi(&data, false)?)?),
        None => Ok(T::default()),
    }
}
fn vault_write<T: Serialize>(c: &Connection, key: &str, data: &T) -> Res<()> {
    let encrypted = dpapi(&serde_json::to_vec(data)?, true)?;
    c.execute("INSERT INTO vault VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext",params![key,encrypted])?;
    Ok(())
}
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secrets {
    secret_id: String,
    secret_key: String,
    api_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewPassword {
    file_name: String,
    fingerprint: Option<String>,
    password: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Password {
    id: String,
    password: String,
    documents: Vec<String>,
    fingerprint: Option<String>,
    created_at: String,
    last_used_at: String,
}
fn clean(s: &str, max: usize) -> String {
    s.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
fn seal(c: &Connection, id: &str) -> Res<Value> {
    let meta: Option<String> = c
        .query_row("SELECT meta FROM seals WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    Ok(match meta {
        Some(s) => serde_json::from_str(&s)?,
        None => Value::Null,
    })
}
pub(super) fn bytes(root: &Path, id: &str) -> Res<Vec<u8>> {
    Ok(db(root)?.query_row("SELECT image FROM seals WHERE id=?1", [id], |r| r.get(0))?)
}
fn import(c: &mut Connection, name: &str, data: &[u8]) -> Res<Value> {
    if data.is_empty() || data.len() > SEAL_LIMIT {
        return Err("电子章图片不得超过 25 MB".into());
    }
    let reader = ImageReader::new(Cursor::new(data)).with_guessed_format()?;
    let mime = match reader.format() {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Jpeg) => "image/jpeg",
        _ => return Err("仅支持 PNG 和 JPEG 外观电子章".into()),
    };
    let (w, h) = reader.into_dimensions()?;
    if w == 0 || h == 0 || w > 20_000 || h > 20_000 || u64::from(w) * u64::from(h) > 25_000_000 {
        return Err("电子章图片像素超出限制".into());
    }
    // Validate the actual image, not just its untrusted extension or dimensions.
    let _ = ImageReader::new(Cursor::new(data))
        .with_guessed_format()?
        .decode()?;
    let hash = format!("{:x}", Sha256::digest(data));
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = tx
        .query_row("SELECT meta FROM seals WHERE hash=?1", [&hash], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(s) = existing {
        return Ok(serde_json::from_str(&s)?);
    }
    let id = Uuid::new_v4().to_string();
    let t = now(&tx)?;
    let file_name = clean(name, 180);
    let title = clean(
        Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("电子章"),
        80,
    );
    let meta = json!({"id":id,"name":title,"kind":"appearance-image","mimeType":mime,"fileName":file_name,"byteLength":data.len(),"sha256":hash,"width":w,"height":h,"createdAt":t,"updatedAt":t,"trustStatus":"not-a-digital-signature"});
    tx.execute(
        "INSERT INTO seals(id,hash,updated,meta,image) VALUES(?1,?2,?3,?4,?5)",
        params![id, hash, t, meta.to_string(), data],
    )?;
    tx.commit()?;
    Ok(meta)
}
pub(super) fn execute(root: &Path, action: &str, payload: Value) -> Res<Value> {
    let mut c = db(root)?;
    match action {
        "loadOcrSecrets" => {
            let s: Secrets = vault_read(&c, "ocr")?;
            Ok(
                json!({"tencent":{"secretId":s.secret_id,"secretKey":s.secret_key},"custom":{"apiKey":s.api_key}}),
            )
        }
        "saveOcrSecrets" => {
            let s: Secrets = serde_json::from_value(payload)?;
            if [&s.secret_id, &s.secret_key, &s.api_key]
                .iter()
                .any(|k| k.len() > 4096)
            {
                return Err("凭据过长".into());
            }
            vault_write(&c, "ocr", &s)?;
            Ok(json!(true))
        }
        "loadPdfPasswordHistory" => Ok(serde_json::to_value(vault_read::<Vec<Password>>(
            &c, "pdf",
        )?)?),
        "clearPdfPasswordHistory" => {
            c.execute("DELETE FROM vault WHERE key='pdf'", [])?;
            Ok(json!([]))
        }
        "rememberPdfPassword" | "removePdfPasswordHistoryEntry" => {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut rows: Vec<Password> = vault_read(&tx, "pdf")?;
            if action.starts_with("remove") {
                let id = id(payload)?;
                rows.retain(|r| r.id != id)
            } else {
                let p: NewPassword = serde_json::from_value(payload)?;
                let name = clean(
                    p.file_name.rsplit(['/', '\\']).next().unwrap_or_default(),
                    180,
                );
                if name.is_empty() || p.password.is_empty() || p.password.len() > 2048 {
                    return Err("文件名或 PDF 密码无效".into());
                }
                let t = now(&tx)?;
                let mut r = if let Some(i) = rows.iter().position(|r| r.password == p.password) {
                    rows.remove(i)
                } else {
                    Password {
                        id: Uuid::new_v4().to_string(),
                        password: p.password,
                        documents: vec![],
                        fingerprint: None,
                        created_at: t.clone(),
                        last_used_at: t.clone(),
                    }
                };
                r.documents.retain(|x| x != &name);
                r.documents.insert(0, name);
                r.documents.truncate(6);
                r.last_used_at = t;
                if let Some(s) = p.fingerprint {
                    r.fingerprint = Some(clean(&s, 256))
                }
                rows.insert(0, r);
                rows.truncate(30);
            }
            vault_write(&tx, "pdf", &rows)?;
            tx.commit()?;
            Ok(serde_json::to_value(rows)?)
        }
        "listElectronicSeals" => {
            let mut stmt = c.prepare("SELECT meta FROM seals ORDER BY updated DESC")?;
            let mut result = vec![];
            for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
                result.push(serde_json::from_str::<Value>(&row?)?)
            }
            Ok(Value::Array(result))
        }
        "readElectronicSeal" => seal(&c, &id(payload)?),
        "deleteElectronicSeal" => Ok(json!(
            c.execute("DELETE FROM seals WHERE id=?1", [id(payload)?])? > 0
        )),
        "updateElectronicSeal" => {
            #[derive(Deserialize)]
            struct Patch {
                name: Option<String>,
                notes: Option<String>,
            }
            let patch: Patch = serde_json::from_value(payload["patch"].clone())?;
            let id = id(payload)?;
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut m = seal(&tx, &id)?;
            if m.is_null() {
                return Ok(m);
            }
            if let Some(s) = patch.name {
                let name = clean(&s, 80);
                if !name.is_empty() {
                    m["name"] = json!(name)
                }
            }
            if let Some(s) = patch.notes {
                m["notes"] = json!(clean(&s, 1000))
            }
            let t = now(&tx)?;
            m["updatedAt"] = json!(t);
            tx.execute(
                "UPDATE seals SET updated=?1,meta=?2 WHERE id=?3",
                params![t, m.to_string(), id],
            )?;
            tx.commit()?;
            Ok(m)
        }
        "importElectronicSeal" => {
            let Some(path) = rfd::FileDialog::new()
                .set_title("导入外观电子章（非数字签名）")
                .add_filter("印章图片", &["png", "jpg", "jpeg"])
                .pick_file()
            else {
                return Ok(Value::Null);
            };
            let mut data = Vec::new();
            fs::File::open(&path)?
                .take(SEAL_LIMIT as u64 + 1)
                .read_to_end(&mut data)?;
            import(
                &mut c,
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("电子章"),
                &data,
            )
        }
        _ => Err("未知的资料库操作".into()),
    }
}
