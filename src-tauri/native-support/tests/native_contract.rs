#![cfg(windows)]
use native_support::{binary, feature};
use rusqlite::Connection;
use serde_json::{json, Value};

#[test]
fn public_ocr_api_rejects_bad_sizes_and_cloud_routes_offline() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let caps = feature(root, "getOcrCapabilities", Value::Null).unwrap();
    assert_eq!(caps["engine"], "Windows.Media.Ocr");
    assert!(caps["languages"].is_array());
    assert_eq!(
        feature(root, "testOcrConnection", json!({"provider":"tencent"})).unwrap()["ok"],
        false
    );
    for meta in [
        json!({"width":600,"height":150,"mode":"printed"}),
        json!({"width":1,"height":1,"mode":"handwriting"}),
        json!({"width":32768,"height":32768,"mode":"auto"}),
    ] {
        assert!(binary(root, 0, "ocr", &meta.to_string(), &[255; 4]).is_err());
    }
    assert!(binary(root, 0, "print", "", b"not a print job").is_err());
    assert!(binary(root, 0, "jobBytes", "../bad", &[]).is_err());
    assert!(binary(root, 0, "sealBytes", "../bad", &[]).is_err());
    assert!(feature(root, "not-an-operation", Value::Null).is_err());
    assert!(feature(root, "getPrinters", json!("a".repeat(32_768))).is_err());
}

#[test]
#[ignore = "requires an installed Windows OCR language pack"]
fn installed_ocr_reads_digits_and_returns_original_image_coordinates() {
    let dir = tempfile::tempdir().unwrap();
    let image = image::load_from_memory(include_bytes!("data/printed-digits.png"))
        .unwrap()
        .into_rgba8();
    // Non-origin word, very wide source. Hosts with a 4096-pixel cap will downsample;
    // an implementation that returns reduced-scale or normalized boxes fails the assertion.
    let mut page = image::RgbaImage::from_pixel(5000, 500, image::Rgba([255; 4]));
    image::imageops::overlay(&mut page, &image, 1700, 130);
    let meta = json!({"width":page.width(),"height":page.height(),"mode":"printed"});
    let raw = binary(dir.path(), 0, "ocr", &meta.to_string(), &page).unwrap();
    let result: Value = serde_json::from_slice(&raw).unwrap();
    let text = result["text"]
        .as_str()
        .unwrap()
        .replace(char::is_whitespace, "");
    assert!(text.contains("12345"), "recognized {text}");
    let items = result["items"].as_array().unwrap();
    let first = &items[0]["box"];
    assert!(
        (1730. ..1810.).contains(&first["x"].as_f64().unwrap()),
        "{first}"
    );
    assert!(
        (152. ..210.).contains(&first["y"].as_f64().unwrap()),
        "{first}"
    );
    assert!(items
        .iter()
        .all(|item| item["box"]["width"].as_f64().unwrap() > 0.
            && item["box"]["height"].as_f64().unwrap() > 0.));
    assert_eq!(result["confidence"], 0);
}

#[test]
fn dpapi_records_survive_reopen_without_storing_secrets_in_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let password = format!("pdf-{}", uuid::Uuid::new_v4());
    let key = format!("ocr-{}", uuid::Uuid::new_v4());
    let call = |name: &str, payload: Value| feature(root, name, payload).unwrap();
    assert_eq!(call("loadPdfPasswordHistory", Value::Null), json!([]));
    let secret = json!({"secretId":"test-account","secretKey":key,"apiKey":""});
    assert_eq!(call("saveOcrSecrets", secret), true);
    for file in ["a.pdf", "b.pdf"] {
        call(
            "rememberPdfPassword",
            json!({"fileName":format!("C:\\docs\\{file}"),"password":password}),
        );
    }
    assert_eq!(
        call("loadOcrSecrets", Value::Null)["tencent"]["secretKey"],
        key
    );
    let rows = call("loadPdfPasswordHistory", Value::Null);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["documents"], json!(["b.pdf", "a.pdf"]));
    assert_eq!(rows[0]["password"], password);
    let db = Connection::open(root.join("native-features.sqlite3")).unwrap();
    let encrypted: Vec<u8> = db
        .query_row("SELECT ciphertext FROM vault WHERE key='pdf'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!encrypted
        .windows(password.len())
        .any(|s| s == password.as_bytes()));
    let encrypted: Vec<u8> = db
        .query_row("SELECT ciphertext FROM vault WHERE key='ocr'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!encrypted.windows(key.len()).any(|s| s == key.as_bytes()));
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(db
        .query_row("SELECT 1 FROM pragma_foreign_key_check", [], |_| Ok(()))
        .is_err());
    assert_eq!(
        call("removePdfPasswordHistoryEntry", json!({"id":rows[0]["id"]})),
        json!([])
    );
    assert_eq!(call("clearPdfPasswordHistory", Value::Null), json!([]));
    drop(db);
}
