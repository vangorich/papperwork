#![cfg(windows)]
use native_support::{binary, capture, feature};
use serde_json::{json, Value};
use std::{fs, os::windows::fs::OpenOptionsExt};

#[test]
fn real_status_and_bounded_ocr_input() {
    let d = tempfile::tempdir().unwrap();
    let caps = feature(d.path(), "getOcrCapabilities", json!({})).unwrap();
    assert_eq!(caps["engine"], "Windows.Media.Ocr");
    assert_eq!(caps["modes"], json!(["auto", "printed"]));
    let t = feature(d.path(), "testOcrConnection", json!({"provider":"custom"})).unwrap();
    assert_eq!(t["ok"], false);
    for meta in [
        r#"{"width":0,"height":1,"mode":"auto"}"#,
        r#"{"width":1000000,"height":1000000,"mode":"auto"}"#,
        r#"{"width":1,"height":1,"mode":"handwriting"}"#,
    ] {
        assert!(binary(d.path(), 0, "ocr", meta, &[0; 4]).is_err())
    }
}

#[test]
#[ignore = "requires an installed Windows OCR language"]
fn offline_ocr_recognizes_text_and_returns_input_coordinates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let img = image::load_from_memory(include_bytes!("paper-ocr.png"))
        .unwrap()
        .into_rgba8();
    let status = feature(root, "getOcrStatus", json!({})).unwrap();
    assert_eq!(status["available"], true, "{status}");
    let data = binary(
        root,
        0,
        "ocr",
        &json!({"width":img.width(),"height":img.height(),"mode":"printed"}).to_string(),
        &img,
    )
    .unwrap();
    let res: Value = serde_json::from_slice(&data).unwrap();
    let text = res["text"]
        .as_str()
        .unwrap()
        .replace(' ', "")
        .to_uppercase();
    eprintln!("OCR on {}: {text}", status["model"]);
    assert!(text.contains("PAPER1234"));
    let boxes = res["items"].as_array().unwrap();
    let first = &boxes[0]["box"];
    assert!(first["x"]
        .as_f64()
        .is_some_and(|x| (15.0..67.0).contains(&x)));
    assert!(first["y"]
        .as_f64()
        .is_some_and(|y| (22.0..66.0).contains(&y)));
    assert!(boxes
        .iter()
        .all(|w| w["box"]["width"].as_f64().unwrap() > 0.
            && w["box"]["height"].as_f64().unwrap() > 0.
            && w["box"]["x"].as_f64().unwrap() + w["box"]["width"].as_f64().unwrap() < 640.));
}

#[test]
fn virtual_queue_only_moves_complete_closed_files_and_requires_ack() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path();
    let inbox = root.join("PrintInbox");
    fs::create_dir_all(&inbox).unwrap();
    let p = inbox.join("PaperworkPrint.pdf");
    fs::write(&p, b"%PDF-1.7 partial").unwrap();
    assert!(!capture(root, &p).unwrap());
    assert!(p.exists());
    let bytes = b"%PDF-1.7 fixture\n%%EOF\n";
    fs::write(&p, bytes).unwrap();
    let f = fs::OpenOptions::new()
        .write(true)
        .share_mode(1)
        .open(&p)
        .unwrap();
    assert!(!capture(root, &p).unwrap());
    drop(f);
    assert!(capture(root, &p).unwrap());
    let pending = feature(root, "takeVirtualPrintJobs", json!({})).unwrap();
    let id = pending[0]["id"].as_str().unwrap();
    assert_eq!(binary(root, 0, "jobBytes", id, &[]).unwrap(), bytes);
    assert!(feature(
        root,
        "acknowledgeVirtualPrintJobs",
        json!({"ids":["../other.pdf"]})
    )
    .is_err());
    assert_eq!(
        feature(root, "takeVirtualPrintJobs", json!({})).unwrap(),
        pending
    );
    // Postponing A is a peek with a cursor, not deletion of A or starvation of B.
    let later = format!("9999999999999-{}", uuid::Uuid::new_v4());
    fs::write(root.join("virtual-jobs").join(format!("{later}.pdf")), bytes).unwrap();
    let second = feature(root, "takeVirtualPrintJobs", json!({"after":id,"limit":32})).unwrap();
    assert_eq!(second[0]["id"], later);
    assert_eq!(feature(root, "takeVirtualPrintJobs", json!({})).unwrap(), pending);
    feature(root, "acknowledgeVirtualPrintJobs", json!({"ids":[id,later]})).unwrap();
    assert_eq!(
        feature(root, "takeVirtualPrintJobs", json!({})).unwrap(),
        json!([])
    );
}
