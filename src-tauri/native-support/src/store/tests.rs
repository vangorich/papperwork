use super::*;

#[test]
fn sqlite_seals_deduplicate_reopen_and_remove() -> Res<()> {
    let d = tempfile::tempdir()?;
    let root = d.path();
    let png = include_bytes!("../../tests/paper-ocr.png");
    let mut c = db(root)?;
    let s = import(&mut c, "stamp.png", png)?;
    let id = s["id"].as_str().unwrap().to_string();
    assert_eq!(import(&mut c, "duplicate.png", png)?, s);
    assert!(import(&mut c, "bad.png", &png[..60]).is_err());
    drop(c);
    let listed = execute(root, "listElectronicSeals", json!({}))?;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let changed = execute(
        root,
        "updateElectronicSeal",
        json!({"id":id,"patch":{"name":" Company ","notes":"示例"}}),
    )?;
    assert_eq!(changed["name"], "Company");
    assert_eq!(bytes(root, &id)?, png);
    assert_eq!(changed["trustStatus"], "not-a-digital-signature");
    assert_eq!(
        execute(root, "deleteElectronicSeal", json!({"id":id}))?,
        true
    );
    let c = db(root)?;
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
        "ok"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get::<_, usize>(0)
        })?,
        0
    );
    let plan = c.query_row(
        "EXPLAIN QUERY PLAN SELECT meta FROM seals ORDER BY updated DESC",
        [],
        |r| r.get::<_, String>(3),
    )?;
    assert!(plan.contains("seals_updated"));
    Ok(())
}

#[test]
#[cfg(windows)]
fn secrets_and_history_use_user_dpapi_not_plaintext() -> Res<()> {
    let d = tempfile::tempdir()?;
    let root = d.path();
    let marker = "private-fixture-do-not-store-in-clear-49f0";
    execute(
        root,
        "saveOcrSecrets",
        json!({"secretId":"aa","secretKey":marker,"apiKey":"bb"}),
    )?;
    assert_eq!(
        execute(root, "loadOcrSecrets", Value::Null)?["tencent"]["secretKey"],
        marker
    );
    for f in ["dir/old.pdf", "current.pdf"] {
        execute(
            root,
            "rememberPdfPassword",
            json!({"fileName":f,"password":marker}),
        )?;
    }
    let rows = execute(root, "loadPdfPasswordHistory", Value::Null)?;
    assert_eq!(rows[0]["documents"], json!(["current.pdf", "old.pdf"]));
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["password"], marker);
    let on_disk = fs::read(root.join("native-features.sqlite3"))?;
    assert!(!on_disk
        .windows(marker.len())
        .any(|s| s == marker.as_bytes()));
    assert_eq!(
        execute(
            root,
            "removePdfPasswordHistoryEntry",
            json!({"id":rows[0]["id"]})
        )?,
        json!([])
    );
    // Corrupt ciphertext fails closed and is not silently replaced by an empty history.
    let c = db(root)?;
    c.execute("UPDATE vault SET ciphertext=x'00' WHERE key='pdf'", [])?;
    assert!(execute(
        root,
        "rememberPdfPassword",
        json!({"fileName":"f","password":"x"})
    )
    .is_err());
    assert_eq!(
        execute(root, "clearPdfPasswordHistory", Value::Null)?,
        json!([])
    );
    Ok(())
}
