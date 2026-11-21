//! Synthetic Outlook storages only; no mail client, account or filesystem fixture is needed.
use cfb::{CompoundFile, Version};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
    path::Path,
};

const ROOT: &str = "";
const RECIP: &str = "/__recip_version1.0_#00000000";
const CC: &str = "/__recip_version1.0_#00000001";
const BCC: &str = "/__recip_version1.0_#00000002";
const ATTACH: &str = "/__attach_version1.0_#00000000";

// MS-OXMSG: fixed-size properties live inline; variable properties reference a sibling stream.
struct Fixture {
    file: CompoundFile<Cursor<Vec<u8>>>,
    props: BTreeMap<String, Vec<(u32, u64)>>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_version(Version::V3)
    }
    fn with_version(version: Version) -> Self {
        let mut file = CompoundFile::create_with_version(version, Cursor::new(vec![])).unwrap();
        file.set_storage_clsid("/", uuid::uuid!("00020d0b-0000-0000-c000-000000000046"))
            .unwrap();
        file.create_storage("/__nameid_version1.0").unwrap();
        for tag in ["00020102", "00030102", "00040102"] {
            file.create_stream(format!("/__nameid_version1.0/__substg1.0_{tag}"))
                .unwrap();
        }
        Self {
            file,
            props: BTreeMap::new(),
        }
    }
    fn mail(class: &str) -> Self {
        let mut f = Self::new();
        f.wide(ROOT, 0x001a, class);
        f
    }
    fn fixed(&mut self, dir: &str, tag: u32, value: u64) {
        if !dir.is_empty() && !self.file.is_storage(dir) {
            self.file.create_storage_all(dir).unwrap();
        }
        self.props
            .entry(dir.to_owned())
            .or_default()
            .push((tag, value));
    }
    fn stream(&mut self, dir: &str, tag: u32, value: &[u8]) {
        let terminator = match tag as u16 {
            0x001e => 1,
            0x001f => 2,
            _ => 0,
        };
        self.fixed(dir, tag, (value.len() + terminator) as u64);
        self.file
            .create_stream(format!("{dir}/__substg1.0_{tag:08X}"))
            .unwrap()
            .write_all(value)
            .unwrap();
    }
    fn wide(&mut self, dir: &str, id: u16, text: &str) {
        self.stream(
            dir,
            (u32::from(id) << 16) | 0x001f,
            &text
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
    }
    fn finish(mut self) -> Vec<u8> {
        let recips = self
            .props
            .keys()
            .filter(|p| p.starts_with("/__recip_"))
            .count() as u32;
        let attachments = self
            .props
            .keys()
            .filter(|p| p.starts_with("/__attach_") && !p[1..].contains('/'))
            .count() as u32;
        for (dir, rows) in self.props {
            let mut data = vec![0; if dir.is_empty() { 32 } else { 8 }];
            if dir.is_empty() {
                for (offset, n) in [
                    (8, recips),
                    (12, attachments),
                    (16, recips),
                    (20, attachments),
                ] {
                    data[offset..offset + 4].copy_from_slice(&n.to_le_bytes());
                }
            }
            for (tag, value) in rows {
                data.extend(tag.to_le_bytes());
                data.extend(6u32.to_le_bytes());
                data.extend(value.to_le_bytes());
            }
            self.file
                .create_stream(format!("{dir}/__properties_version1.0"))
                .unwrap()
                .write_all(&data)
                .unwrap();
        }
        self.file.flush().unwrap();
        self.file.into_inner().into_inner()
    }
}
fn synthetic_memo() -> Vec<u8> {
    let mut f = Fixture::mail("IPM.Note");
    f.wide(ROOT, 0x0037, "项目简报 · Synthetic memo");
    f.wide(ROOT, 0x0c1a, "测试发件人");
    f.wide(ROOT, 0x5d01, "sender@example.invalid");
    f.wide(
        ROOT,
        0x1000,
        "第一段：保留换行。\r\n\r\nSecond paragraph 📨\rLast line.",
    );
    f.fixed(ROOT, 0x00390040, 133_485_408_000_000_000); // 2024-01-01 00:00:00 UTC
    for (dir, kind, name, address) in [
        (RECIP, 1, "读者", "reader@example.invalid"),
        (CC, 2, "抄送", ""),
        (BCC, 3, "", "bcc@example.invalid"),
    ] {
        f.fixed(dir, 0x0c150003, kind);
        f.wide(dir, 0x3001, name);
        f.wide(dir, 0x39fe, address);
    }
    f.wide(ATTACH, 0x3704, "ATTACH~1.PDF");
    f.wide(ATTACH, 0x3707, "附件说明.pdf");
    f.stream(
        ATTACH,
        0x37010102,
        b"attachment body must not enter the memo",
    );
    f.finish()
}
fn parse(bytes: &[u8]) -> Result<Value, String> {
    let reply = native_support::binary(Path::new(""), 0, "parseOutlookMsg", "", bytes)?;
    Ok(serde_json::from_slice(&reply).unwrap())
}
#[test]
fn memo_matches_the_public_contract_and_uses_only_attachment_names() {
    assert_eq!(
        parse(&synthetic_memo()).unwrap(),
        json!({
            "subject":"项目简报 · Synthetic memo", "from":"测试发件人 <sender@example.invalid>",
            "to":["读者 <reader@example.invalid>"], "cc":["抄送"], "bcc":["bcc@example.invalid"],
            "sentAt":"2024-01-01T00:00:00Z", "body":"第一段：保留换行。\n\nSecond paragraph 📨\nLast line.",
            "attachments":["附件说明.pdf"], "warnings":[]
        })
    );
}
#[test]
fn ansi_mail_uses_its_codepage_and_preserves_an_explicit_empty_body() {
    let mut f = Fixture::new();
    f.stream(ROOT, 0x001a001e, b"IPM.Note\0");
    f.fixed(ROOT, 0x3ffd0003, 936);
    f.stream(ROOT, 0x0037001e, b"\xd6\xd0\xce\xc4"); // GBK 中文
    f.stream(ROOT, 0x1000001e, b"");
    f.wide(ROOT, 0x0e04, "Li, Xia; Pat");
    let msg = parse(&f.finish()).unwrap();
    assert_eq!(msg["subject"], "中文");
    assert_eq!(msg["body"], "");
    assert_eq!(msg["to"], json!(["Li, Xia", "Pat"]));
    assert_eq!(msg["warnings"], json!([]));
    assert!(msg.get("sentAt").is_none());
}
#[test]
fn html_only_mail_has_visible_text_but_no_resources_or_hidden_content() {
    let mut f = Fixture::mail("IPM.Note");
    f.wide(ROOT, 0x1000, ""); // Empty plain alternative must not mask the HTML body.
    let html = "<!DOCTYPE html><html><head><title>private title</title><style>p{color:red}</style></head><body><p>中文 &amp; café<br>second</p><div hidden>hidden value</div><script>not visible</script><a href='https://example.invalid/remote'>end</a><img src='cid:private'></body></html>";
    f.stream(ROOT, 0x10130102, html.as_bytes());
    let msg = parse(&f.finish()).unwrap();
    assert_eq!(msg["body"], "中文 & café\nsecond\nend");
    assert!(!msg["warnings"].as_array().unwrap().is_empty());
}
#[test]
fn non_mail_compound_files_protected_classes_and_foreign_metadata_are_rejected() {
    let non_mail = Fixture::new().finish();
    for invalid in [
        &b"not a compound file"[..],
        &non_mail,
        &Fixture::mail("IPM.Contact").finish(),
        &Fixture::mail("IPM.Note.SMIME").finish(),
    ] {
        assert!(parse(invalid).is_err());
    }
    let mut encrypted = Fixture::mail("IPM.Note");
    encrypted.fixed(ROOT, 0x6e010003, 1);
    encrypted.wide(ROOT, 0x1000, "Placeholder only");
    assert!(parse(&encrypted.finish()).is_err());
    assert!(native_support::binary(
        Path::new(""),
        0,
        "parseOutlookMsg",
        "path",
        &synthetic_memo()
    )
    .is_err());
}
#[test]
fn missing_or_unreadable_body_is_not_reported_as_complete() {
    let absent = parse(&Fixture::mail("IPM.Note").finish()).unwrap();
    assert_eq!(absent["body"], "");
    assert!(!absent["warnings"].as_array().unwrap().is_empty());
    let mut broken = Fixture::mail("IPM.Note");
    broken.stream(ROOT, 0x10090102, b"not compressed RTF");
    assert!(parse(&broken.finish()).is_err());
}

// Build both MS-OXRTFCP wrappers independently of the reader. The compressed form uses
// the standard 207-byte dictionary, a back-reference to its prefix, literals and the end token.
fn rtf_packet(raw: &[u8], compressed: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut crc = 0u32;
    if compressed {
        assert!(raw.starts_with(br"{\rtf1\ansi"));
        let mut tokens = vec![(true, vec![0, 9])]; // offset 0, length 11
        tokens.extend(raw[11..].iter().map(|b| (false, vec![*b])));
        let end = (((207 + raw.len()) % 4096) as u16) << 4;
        tokens.push((true, end.to_be_bytes().to_vec()));
        for group in tokens.chunks(8) {
            let flags = group
                .iter()
                .enumerate()
                .fold(0, |f, (i, (reference, _))| f | (u8::from(*reference) << i));
            payload.push(flags);
            for (_, token) in group {
                payload.extend(token);
            }
        }
        for &b in &payload {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 0 {
                    crc >> 1
                } else {
                    (crc >> 1) ^ 0xedb88320
                };
            }
        }
    } else {
        payload.extend(raw);
    }
    let mut out = Vec::new();
    out.extend(((payload.len() + 12) as u32).to_le_bytes());
    out.extend((raw.len() as u32).to_le_bytes());
    out.extend(if compressed { b"LZFu" } else { b"MELA" });
    out.extend(crc.to_le_bytes());
    out.extend(payload);
    out
}
#[test]
fn lzfu_and_mela_decode_grouped_multibyte_unicode_and_visible_field_results() {
    let raw = br"{\rtf1\ansi\ansicpg936{\fonttbl{\f0 Arial;}}{\*\generator private metadata;}\uc1\'d6\'d0\'ce\'c4\par \u-10179?\u-8704?{\pict 414243}{\v hidden}{\field{\*\fldinst IGNORE INSTRUCTION}{\fldrslt label}}\tab End}";
    for compressed in [true, false] {
        let mut f = Fixture::mail("IPM.Note");
        f.stream(ROOT, 0x10090102, &rtf_packet(raw, compressed));
        let msg = parse(&f.finish()).unwrap();
        assert_eq!(msg["body"], "中文\n😀label\tEnd");
        assert!(!msg["warnings"].as_array().unwrap().is_empty());
    }
}
#[test]
fn encapsulated_html_is_also_reduced_to_text_and_corrupt_rtf_fails_closed() {
    let raw = br"{\rtf1\ansi\fromhtml1{\*\htmltag0 <p>}Body &amp; text{\*\htmltag0 </p>}{\*\htmltag0 <style>}ignored{\*\htmltag0 </style>}\htmlrtf RTF duplicate\htmlrtf0 End}";
    let mut packet = rtf_packet(raw, true);
    let mut f = Fixture::mail("IPM.Note");
    f.stream(ROOT, 0x10090102, &packet);
    assert_eq!(parse(&f.finish()).unwrap()["body"], "Body & text\nEnd");
    packet[12] ^= 1; // Simulate a damaged saved message (wrong checksum).
    let mut f = Fixture::mail("IPM.Note");
    f.stream(ROOT, 0x10090102, &packet);
    assert!(parse(&f.finish()).is_err());
}
#[test]
fn transport_fallback_unfolds_headers_and_never_exposes_trace_fields() {
    let mut f = Fixture::mail("IPM.Note");
    f.wide(ROOT,0x007d,"Received: private trace\r\nFrom: Author <a@example.invalid>\r\nTo: \"Roe, Jo\" <j@example.invalid>,\r\n Reader <r@example.invalid>\r\nSubject: Folded\r\n subject\r\nDate: Mon, 1 Jan 2024 08:00:00 +0800\r\n\r\nCc: not a header\r\n");
    f.wide(ROOT, 0x1000, "body");
    let msg = parse(&f.finish()).unwrap();
    assert_eq!(msg["subject"], "Folded subject");
    assert_eq!(msg["from"], "Author <a@example.invalid>");
    assert_eq!(
        msg["to"],
        json!([
            "\"Roe, Jo\" <j@example.invalid>",
            "Reader <r@example.invalid>"
        ])
    );
    assert_eq!(msg["cc"], json!([]));
    assert_eq!(msg["sentAt"], "2024-01-01T00:00:00Z");
    assert!(!msg.to_string().contains("private trace"));
}
#[test]
fn html_charset_and_optional_head_end_do_not_hide_the_body() {
    let mut f = Fixture::mail("IPM.Note");
    f.stream(ROOT,0x10130102,b"<HTML><HEAD><META http-equiv='Content-Type' content='text/html; charset=windows-1252'><BODY><script src='cid:x'/>not visible</script><p>caf\xe9<br><br>end</p>");
    assert_eq!(parse(&f.finish()).unwrap()["body"], "café\n\nend");
}
#[test]
fn input_fields_nested_text_and_number_of_attachments_are_limited() {
    assert_eq!(native_support::MAX_OUTLOOK_MSG_BYTES, 32 * 1024 * 1024);
    assert!(parse(&vec![0; native_support::MAX_OUTLOOK_MSG_BYTES + 1])
        .unwrap_err()
        .contains("32 MiB"));
    let mut f = Fixture::mail("IPM.Note");
    f.wide(ROOT, 0x0037, &"x".repeat(9000));
    assert!(parse(&f.finish()).is_err());
    let mut f = Fixture::mail("IPM.Note");
    f.stream(ROOT, 0x10130102, "<div>".repeat(129).as_bytes());
    assert!(parse(&f.finish()).is_err());
    let mut f = Fixture::mail("IPM.Note");
    for i in 0..129 {
        f.wide(
            &format!("/__attach_version1.0_#{i:08X}"),
            0x3707,
            "sample.txt",
        );
    }
    assert!(parse(&f.finish()).is_err());
}

#[test]
fn v4_regular_streams_decode_ansi_body_and_do_not_follow_embedded_messages() {
    let mut f = Fixture::with_version(Version::V4);
    f.stream(ROOT, 0x001a001e, b"IPM.Note");
    f.fixed(ROOT, 0x3ffd0003, 1252);
    f.stream(ROOT, 0x1000001e, &b"caf\xe9\r\n".repeat(1000));
    f.wide(ATTACH, 0x3707, r"folder\nested.msg");
    f.fixed(ATTACH, 0x37050003, 5);
    f.wide(
        &format!("{ATTACH}/__substg1.0_3701000D"),
        0x1000,
        "private nested body",
    );
    let msg = parse(&f.finish()).unwrap();
    assert_eq!(msg["body"], "café\n".repeat(1000));
    assert_eq!(msg["attachments"], json!(["nested.msg"]));
    assert!(!msg.to_string().contains("private nested body"));
}

#[test]
fn uses_readable_alternative_with_warnings_for_unreadable_or_protected_parts() {
    let mut f = Fixture::mail("IPM.Note");
    f.stream(ROOT, 0x1000001f, &[0x61]); // Incomplete UTF-16 unit, not a usable body.
    f.stream(ROOT, 0x10130102, b"<p>Readable alternative</p>");
    f.wide(ATTACH, 0x3707, "protected.bin");
    f.wide(ATTACH, 0x370e, "application/x-microsoft-rpmsg-message");
    let msg = parse(&f.finish()).unwrap();
    assert_eq!(msg["body"], "Readable alternative");
    let warnings = msg["warnings"].as_array().unwrap();
    for reason in ["纯文本", "HTML", "受保护"] {
        assert!(warnings
            .iter()
            .any(|v| v.as_str().unwrap().contains(reason)));
    }
}

// Optional native UI/E2E input. Explicit destination, never overwrite a file.
#[test]
#[ignore = "set OUTLOOK_MSG_FIXTURE to a new file path to export the synthetic memo"]
fn write_synthetic_outlook_fixture() {
    let path = std::env::var_os("OUTLOOK_MSG_FIXTURE").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap()
        .write_all(&synthetic_memo())
        .unwrap();
}
