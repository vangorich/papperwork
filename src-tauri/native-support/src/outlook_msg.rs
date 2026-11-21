//! Read an ordinary Outlook IPM.Note from immutable bytes. Only strings suitable for a
//! portrait memo cross the IPC boundary; attachment data and HTML never do.
mod container;
mod html;
mod rtf;

use super::Res;
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use container::Container;
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use serde::Serialize;
use std::collections::HashMap;

/// Maximum complete .msg file accepted by the memo importer, including all attachments.
pub const MAX_OUTLOOK_MSG_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_FIELD: usize = 16 * 1024;
const MAX_RECIPIENTS: usize = 256;
const MAX_ATTACHMENTS: usize = 128;
const NOT_MSG: &str = "此文件不是有效的 Outlook MSG 邮件";
const PROTECTED: &str = "暂不支持受保护、加密或 S/MIME 签名的 MSG 邮件";
const COUNT_LIMIT: &str = "MSG 的收件人或附件数量超出上限";

/// Wire contract: src/types/outlookMail.ts (MemoMessage).
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Memo {
    subject: String,
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    bcc: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sent_at: Option<String>,
    body: String,
    attachments: Vec<String>,
    warnings: Vec<&'static str>,
}
impl Memo {
    fn warn(&mut self, warning: &'static str) {
        if !self.warnings.contains(&warning) {
            self.warnings.push(warning);
        }
    }
}

fn decode(codec: &'static Encoding, bytes: &[u8]) -> Res<String> {
    let text = codec
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or("MSG 的文本编码无效")?;
    Ok(text
        .trim_start_matches('\u{feff}')
        .trim_end_matches('\0')
        .to_owned())
}
fn ansi(bytes: &[u8], codepage: u32) -> Res<String> {
    let codec = match codepage {
        1200 => UTF_16LE,
        1201 => UTF_16BE,
        _ if bytes.is_ascii() && !bytes.contains(&0x1b) => UTF_8,
        0 if std::str::from_utf8(bytes).is_ok() => UTF_8,
        0 | 1252 => WINDOWS_1252,
        65001 => UTF_8,
        932 => encoding_rs::SHIFT_JIS,
        936 => encoding_rs::GBK,
        949 => encoding_rs::EUC_KR,
        950 => encoding_rs::BIG5,
        54936 => encoding_rs::GB18030,
        20866 => encoding_rs::KOI8_R,
        21866 => encoding_rs::KOI8_U,
        50220..=50222 => encoding_rs::ISO_2022_JP,
        51932 => encoding_rs::EUC_JP,
        51949 => encoding_rs::EUC_KR,
        28591..=28606 => Encoding::for_label(format!("iso-8859-{}", codepage - 28590).as_bytes())
            .ok_or("不支持此 MSG 字符集")?,
        _ => Encoding::for_label(format!("windows-{codepage}").as_bytes())
            .ok_or_else(|| format!("不支持此 MSG 字符集（代码页 {codepage}）"))?,
    };
    decode(codec, bytes)
}

fn body_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                out.push('\n');
            }
            '\n' | '\x0b' | '\x0c' | '\u{2028}' | '\u{2029}' => out.push('\n'),
            '\t' => out.push(c),
            _ if !c.is_control() => out.push(c),
            _ => (),
        }
    }
    out
}
fn header_text(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = true;
        } else if !c.is_control() {
            if space && !out.is_empty() {
                out.push(' ');
            }
            out.push(c);
            space = false;
        }
    }
    out
}

impl Container<'_> {
    fn property(&mut self, dir: &str, tag: u32, limit: usize) -> Res<Option<Vec<u8>>> {
        self.bytes(&format!("{dir}/__substg1.0_{tag:08X}"), limit)
    }
    fn text(&mut self, dir: &str, id: u16, cp: u32, limit: usize) -> Res<Option<String>> {
        let tag = u32::from(id) << 16;
        if let Some(b) = self.property(dir, tag | 0x001f, limit)? {
            return Ok(Some(decode(UTF_16LE, &b)?));
        }
        self.property(dir, tag | 0x001e, limit)?
            .map(|b| ansi(&b, cp))
            .transpose()
    }
    fn first(&mut self, dir: &str, ids: &[u16], cp: u32) -> Res<String> {
        for &id in ids {
            if let Some(text) = self.text(dir, id, cp, MAX_FIELD)? {
                let text = header_text(&text);
                if !text.is_empty() {
                    return Ok(text);
                }
            }
        }
        Ok(String::new())
    }
    fn table(&mut self, dir: &str) -> Res<Vec<u8>> {
        let bytes = self
            .bytes(&format!("{dir}/__properties_version1.0"), 128 * 1024)?
            .ok_or(NOT_MSG)?;
        let header = if dir.is_empty() { 32 } else { 8 };
        if bytes.len() < header || !(bytes.len() - header).is_multiple_of(16) {
            return Err(NOT_MSG.into());
        }
        Ok(bytes)
    }
    fn html_body(&mut self, cp: u32) -> Res<Option<String>> {
        let html = if let Some(b) = self.property("", 0x10130102, MAX_TEXT)? {
            Some(html::decode_html(&b, cp)?)
        } else {
            self.text("", 0x1013, cp, MAX_TEXT)?
        };
        html.map(|h| html::visible(&h)).transpose()
    }
    fn body(&mut self, cp: u32, html_cp: u32, memo: &mut Memo) -> Res<String> {
        let mut failed = None;
        let plain = match self.text("", 0x1000, cp, MAX_TEXT) {
            Ok(Some(s)) => {
                let s = body_text(&s);
                if !s.trim().is_empty() {
                    return Ok(s);
                }
                Some(s)
            }
            Ok(None) => None,
            Err(err) => {
                failed = Some(err);
                memo.warn("纯文本正文无法读取，已尝试其他正文格式。");
                None
            }
        };
        match self.html_body(html_cp) {
            Ok(Some(text)) => {
                memo.warn("HTML 正文仅保留可见文字，未载入图片、链接或嵌入内容。");
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
            Ok(None) => (),
            Err(err) => {
                failed = Some(err);
                memo.warn("HTML 正文无法读取，已尝试其他正文格式。");
            }
        }
        if let Some(b) = self.property("", 0x10090102, MAX_TEXT + 16)? {
            let text = body_text(&rtf::visible(&b, cp)?);
            memo.warn("RTF 正文仅保留文字，未保留原排版或嵌入内容。");
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
        if let Some(err) = failed {
            return Err(err);
        }
        if plain.is_none() || !memo.warnings.is_empty() {
            memo.warn("邮件未包含可提取的正文文字。");
        }
        Ok(plain.unwrap_or_default())
    }
}

// The caller has already removed the 32-byte message or 8-byte recipient/attachment header.
fn value(rows: &[u8], tag: u32) -> Option<u64> {
    let key = tag.to_le_bytes();
    rows.chunks_exact(16)
        .find(|r| r[..4] == key)
        .and_then(|r| Some(u64::from_le_bytes(r[8..16].try_into().ok()?)))
}
fn integer(rows: &[u8], tag: u32) -> u32 {
    value(rows, tag).unwrap_or(0) as u32
}
fn filetime(ticks: u64) -> Option<String> {
    if ticks == 0 {
        return None;
    }
    let seconds = (ticks / 10_000_000) as i64 - 11_644_473_600;
    let t = DateTime::<Utc>::from_timestamp(seconds, ((ticks % 10_000_000) * 100) as u32)?;
    (t.year() <= 9999).then(|| t.to_rfc3339_opts(SecondsFormat::AutoSi, true))
}
fn person(name: String, address: String) -> String {
    if name.is_empty() {
        address
    } else if address.contains('@') && !name.eq_ignore_ascii_case(&address) {
        format!("{name} <{address}>")
    } else {
        name
    }
}
fn storage_id(name: &str, prefix: &str) -> Option<u32> {
    let suffix = name.get(prefix.len()..)?;
    if !name.get(..prefix.len())?.eq_ignore_ascii_case(prefix)
        || suffix.len() != 8
        || !suffix.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    u32::from_str_radix(suffix, 16).ok()
}

// Transport headers are a fallback only. Never include the full header block, MIME body,
// or trace/authentication headers in the memo. Preserve folded address lists.
fn envelope(headers: &str) -> HashMap<String, String> {
    let mut out = HashMap::<String, String>::new();
    let mut current = None;
    for line in headers.lines() {
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            if let Some(value) = current.as_ref().and_then(|k| out.get_mut(k)) {
                value.push(' ');
                value.push_str(line.trim());
            }
        } else {
            current = None;
            if let Some((k, v)) = line.split_once(':') {
                let key = k.to_ascii_lowercase();
                if matches!(
                    key.as_str(),
                    "subject" | "from" | "to" | "cc" | "bcc" | "date"
                ) && !out.contains_key(&key)
                {
                    out.insert(key.clone(), v.trim().to_owned());
                    current = Some(key);
                }
            }
        }
    }
    out
}
fn address_list(s: &str, transport: bool) -> Res<Vec<String>> {
    let mut list = Vec::new();
    let (mut quoted, mut angled, mut escaped) = (false, false, false);
    let mut start = 0;
    for (i, c) in s.char_indices().chain(std::iter::once((s.len(), ';'))) {
        if i != s.len() {
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                '\\' if quoted => escaped = true,
                '"' => quoted = !quoted,
                '<' if !quoted => angled = true,
                '>' if !quoted => angled = false,
                _ => (),
            }
        }
        if i == s.len() || (!quoted && !angled && (c == ';' || (transport && c == ','))) {
            let entry = header_text(&s[start..i]);
            if !entry.is_empty() {
                list.push(entry);
            }
            if list.len() > MAX_RECIPIENTS {
                return Err(COUNT_LIMIT.into());
            }
            start = i + 1;
        }
    }
    Ok(list)
}

pub(super) fn parse(data: &[u8]) -> Res<Memo> {
    let mut msg = Container::open(data)?;
    if msg.file.exists("/EncryptedPackage") || msg.file.exists("/EncryptionInfo") {
        return Err(PROTECTED.into());
    }
    let table = msg.table("")?;
    let rows = &table[32..];
    let recip_count = u32::from_le_bytes(table[16..20].try_into()?) as usize;
    let attach_count = u32::from_le_bytes(table[20..24].try_into()?) as usize;
    if recip_count > MAX_RECIPIENTS || attach_count > MAX_ATTACHMENTS {
        return Err(COUNT_LIMIT.into());
    }
    let msg_cp = integer(rows, 0x3ffd0003);
    let inet_cp = integer(rows, 0x3fde0003);
    let cp = if msg_cp == 0 { inet_cp } else { msg_cp };
    if value(rows, 0x001a001f).is_none() && value(rows, 0x001a001e).is_none() {
        return Err(NOT_MSG.into());
    }
    let class = msg.first("", &[0x001a], cp)?.to_ascii_lowercase();
    if class.starts_with("ipm.note.smime")
        || class.starts_with("ipm.note.rpmsg")
        || integer(rows, 0x6e010003) & 1 != 0
    {
        return Err(PROTECTED.into());
    }
    if class != "ipm.note" {
        return Err("仅支持 Outlook 普通电子邮件（IPM.Note），不支持此 MSG 项目类型".into());
    }

    let mut memo = Memo::default();
    memo.body = msg.body(cp, if inet_cp == 0 { cp } else { inet_cp }, &mut memo)?;
    if memo.body.len() > MAX_TEXT {
        return Err("MSG 正文文本超出大小限制".into());
    }
    let headers = match msg.text("", 0x007d, cp, 256 * 1024) {
        Ok(Some(text)) => envelope(&text),
        Ok(None) => HashMap::new(),
        Err(_) => {
            memo.warn("备用传输邮件头过长或编码不受支持，已使用 MSG 信封字段。");
            HashMap::new()
        }
    };
    let header = |name: &str| headers.get(name).map(String::as_str).unwrap_or("");
    memo.subject = msg.first("", &[0x0037, 0x0e1d], cp)?;
    if memo.subject.is_empty() {
        memo.subject = header_text(header("subject"));
    }
    memo.from = person(
        msg.first("", &[0x0c1a], cp)?,
        msg.first("", &[0x5d01, 0x0c1f], cp)?,
    );
    if memo.from.is_empty() {
        memo.from = person(
            msg.first("", &[0x0042], cp)?,
            msg.first("", &[0x5d02, 0x0065], cp)?,
        );
    }
    if memo.from.is_empty() {
        memo.from = header_text(header("from"));
    }
    memo.sent_at = value(rows, 0x00390040)
        .and_then(filetime)
        .or_else(|| value(rows, 0x0e060040).and_then(filetime))
        .or_else(|| {
            DateTime::parse_from_rfc2822(header("date")).ok().map(|t| {
                t.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Secs, true)
            })
        });

    let mut recipients = Vec::new();
    let mut attachments = Vec::new();
    for item in msg.file.read_root_storage().filter(|e| e.is_storage()) {
        let name = item.name();
        if let Some(id) = storage_id(name, "__recip_version1.0_#") {
            recipients.push((id, format!("/{name}")));
        } else if let Some(id) = storage_id(name, "__attach_version1.0_#") {
            attachments.push((id, format!("/{name}")));
        }
        if recipients.len() > MAX_RECIPIENTS || attachments.len() > MAX_ATTACHMENTS {
            return Err(COUNT_LIMIT.into());
        }
    }
    if recipients.len() != recip_count || attachments.len() != attach_count {
        memo.warn("邮件列出的收件人或附件数量与实际存储不符。");
    }
    recipients.sort_unstable_by_key(|(id, _)| *id);
    attachments.sort_unstable_by_key(|(id, _)| *id);
    for (_, dir) in recipients {
        let props = msg.table(&dir)?;
        let kind = integer(&props[8..], 0x0c150003) & 0x0fff_ffff;
        let recipient = person(
            msg.first(&dir, &[0x3001, 0x3a20], cp)?,
            msg.first(&dir, &[0x39fe, 0x3003], cp)?,
        );
        if recipient.is_empty() {
            memo.warn("部分收件人没有可读取的名称或地址。");
            continue;
        }
        match kind {
            1 => memo.to.push(recipient),
            2 => memo.cc.push(recipient),
            3 => memo.bcc.push(recipient),
            _ => memo.warn("邮件包含未识别的收件人类型。"),
        }
    }
    for (list, prop, field) in [
        (&mut memo.to, 0x0e04, "to"),
        (&mut memo.cc, 0x0e03, "cc"),
        (&mut memo.bcc, 0x0e02, "bcc"),
    ] {
        if list.is_empty() {
            let display = msg.first("", &[prop], cp)?;
            *list = if display.is_empty() {
                address_list(header(field), true)?
            } else {
                address_list(&display, false)?
            };
        }
    }
    if memo.to.len() + memo.cc.len() + memo.bcc.len() > MAX_RECIPIENTS {
        return Err(COUNT_LIMIT.into());
    }
    for (_, dir) in attachments {
        let path = msg.first(&dir, &[0x3707, 0x3704, 0x3001], cp)?;
        let name = path.rsplit(['/', '\\']).next().unwrap_or("").trim();
        let name = if matches!(name, "" | "." | "..") {
            "未命名附件"
        } else {
            name
        };
        let mime = msg.first(&dir, &[0x370e], cp)?.to_ascii_lowercase();
        let mime = mime.split(';').next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case("message.rpmsg")
            || name.eq_ignore_ascii_case("smime.p7m")
            || matches!(
                mime,
                "application/x-microsoft-rpmsg-message"
                    | "application/pkcs7-mime"
                    | "application/x-pkcs7-mime"
            )
        {
            memo.warn("邮件含受保护或签名的附件；此备忘录不含其中的正文。");
        }
        memo.attachments.push(name.to_owned());
    }
    Ok(memo)
}
