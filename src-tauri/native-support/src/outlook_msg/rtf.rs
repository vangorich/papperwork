//! MS-OXRTFCP (LZFu/MELA) → a bounded text-only RTF reader. No RichEdit, OLE or callbacks.
use super::{ansi, html, Res, MAX_TEXT};
use std::borrow::Cow;

const BAD: &str = "MSG 的 RTF 正文损坏或格式不受支持";
const DICTIONARY: &[u8] = b"{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

fn unpack(data: &[u8]) -> Res<Cow<'_, [u8]>> {
    let payload = data.get(16..).ok_or(BAD)?;
    let size = u32::from_le_bytes(data[..4].try_into()?) as usize;
    let raw = u32::from_le_bytes(data[4..8].try_into()?) as usize;
    if size != data.len() - 4 || raw > MAX_TEXT {
        return Err(BAD.into());
    }
    match &data[8..12] {
        b"MELA" if payload.len() == raw => return Ok(Cow::Borrowed(payload)),
        b"LZFu" => (),
        _ => return Err(BAD.into()),
    }
    // This variant of CRC-32 has an all-zero starting register and no final inversion.
    let mut crc = crc32fast::Hasher::new_with_initial(u32::MAX);
    crc.update(payload);
    if !crc.finalize() != u32::from_le_bytes(data[12..16].try_into()?) {
        return Err(BAD.into());
    }
    let mut dictionary = [0u8; 4096];
    dictionary[..DICTIONARY.len()].copy_from_slice(DICTIONARY);
    let mut write = DICTIONARY.len();
    let mut out = Vec::with_capacity(raw);
    let mut input = payload.iter().copied();
    while let Some(flags) = input.next() {
        for bit in 0..8 {
            if flags & (1 << bit) == 0 {
                let byte = input.next().ok_or(BAD)?;
                if out.len() == raw {
                    return Err(BAD.into());
                }
                out.push(byte);
                dictionary[write] = byte;
                write = (write + 1) % 4096;
            } else {
                let pair = u16::from_be_bytes([input.next().ok_or(BAD)?, input.next().ok_or(BAD)?]);
                let mut offset = usize::from(pair >> 4);
                if offset == write {
                    return if out.len() == raw {
                        Ok(Cow::Owned(out))
                    } else {
                        Err(BAD.into())
                    };
                }
                let count = usize::from(pair & 15) + 2;
                if count > raw - out.len() {
                    return Err(BAD.into());
                }
                for _ in 0..count {
                    let byte = dictionary[offset];
                    out.push(byte);
                    dictionary[write] = byte;
                    write = (write + 1) % 4096;
                    offset = (offset + 1) % 4096;
                }
            }
        }
    }
    Err(BAD.into())
}

#[derive(Clone, Copy)]
struct Scope {
    skip: bool,
    starred: bool,
    hidden: bool,
    deleted: bool,
    htmlrtf: bool,
    uc: usize,
    codepage: u32,
}
impl Scope {
    fn visible(self, from_html: bool) -> bool {
        !self.skip && !self.hidden && !self.deleted && !(from_html && self.htmlrtf)
    }
}

fn skip_destination(word: &[u8]) -> bool {
    matches!(
        word,
        b"fonttbl"
            | b"colortbl"
            | b"stylesheet"
            | b"info"
            | b"filetbl"
            | b"revtbl"
            | b"listtable"
            | b"listoverridetable"
            | b"rsidtbl"
            | b"generator"
            | b"pict"
            | b"shp"
            | b"shppict"
            | b"nonshppict"
            | b"object"
            | b"objdata"
            | b"datastore"
            | b"themedata"
            | b"colorschememapping"
            | b"header"
            | b"headerl"
            | b"headerr"
            | b"headerf"
            | b"footer"
            | b"footerl"
            | b"footerr"
            | b"footerf"
            | b"annotation"
            | b"fldinst"
            | b"xmlopen"
            | b"xmlattrname"
            | b"xmlattrvalue"
    )
}
fn flush(bytes: &mut Vec<u8>, codepage: u32, out: &mut Vec<u16>) -> Res<()> {
    if !bytes.is_empty() {
        if bytes.is_ascii() && !bytes.contains(&0x1b) {
            out.extend(bytes.iter().copied().map(u16::from));
        } else {
            out.extend(ansi(bytes, codepage)?.encode_utf16());
        }
        bytes.clear();
    }
    if out.len() > MAX_TEXT {
        return Err("MSG RTF 提取文本过长".into());
    }
    Ok(())
}

pub(super) fn visible(compressed: &[u8], codepage: u32) -> Res<String> {
    let raw = unpack(compressed)?;
    if !raw.starts_with(b"{\\rtf1") {
        return Err(BAD.into());
    }
    let mut s = Scope {
        skip: false,
        starred: false,
        hidden: false,
        deleted: false,
        htmlrtf: false,
        uc: 1,
        codepage: if codepage == 0 { 1252 } else { codepage },
    };
    let mut stack = Vec::new();
    let mut bytes = Vec::new(); // Consecutive literal and hex-escaped bytes are one multibyte string.
    let mut out = Vec::new(); // \u is a UTF-16 unit, including surrogate pairs split across controls.
    let mut i = 0;
    let mut fallback = 0;
    let mut from_html = false;
    while i < raw.len() {
        let byte = raw[i];
        i += 1;
        match byte {
            b'{' => {
                flush(&mut bytes, s.codepage, &mut out)?;
                if stack.len() == 128 {
                    return Err("MSG RTF 正文嵌套过深".into());
                }
                stack.push(s);
                fallback = 0;
            }
            b'}' => {
                flush(&mut bytes, s.codepage, &mut out)?;
                s = stack.pop().ok_or(BAD)?;
                fallback = 0;
                if stack.is_empty() {
                    if !raw[i..].iter().all(|b| *b == 0 || b.is_ascii_whitespace()) {
                        return Err(BAD.into());
                    }
                    break;
                }
            }
            b'\r' | b'\n' => (), // Newlines in RTF source are not paragraph breaks.
            b'\\' => {
                let ctrl = *raw.get(i).ok_or(BAD)?;
                i += 1;
                if ctrl == b'\'' {
                    let hex = raw.get(i..i + 2).ok_or(BAD)?;
                    let b = u8::from_str_radix(std::str::from_utf8(hex).map_err(|_| BAD)?, 16)
                        .map_err(|_| BAD)?;
                    i += 2;
                    if fallback > 0 {
                        fallback -= 1;
                    } else if s.visible(from_html) {
                        bytes.push(b);
                    }
                    continue;
                }
                flush(&mut bytes, s.codepage, &mut out)?;
                if !ctrl.is_ascii_alphabetic() {
                    if fallback > 0 {
                        fallback -= 1;
                        continue;
                    }
                    if ctrl == b'*' {
                        s.starred = true;
                    } else if s.visible(from_html) {
                        match ctrl {
                            b'{' | b'}' | b'\\' => out.push(u16::from(ctrl)),
                            b'~' => out.push(0x00a0),
                            b'_' => out.push(0x2011),
                            b'-' => out.push(0xad),
                            b'\n' | b'\r' => out.push(10),
                            _ => (),
                        }
                    }
                    continue;
                }
                let start = i - 1;
                while raw.get(i).is_some_and(u8::is_ascii_alphabetic) {
                    i += 1;
                }
                let word = &raw[start..i];
                let negative = raw.get(i) == Some(&b'-');
                if negative {
                    i += 1;
                }
                let digits = i;
                let mut n = 0i32;
                while let Some(b) = raw.get(i).filter(|b| b.is_ascii_digit()) {
                    n = n.saturating_mul(10).saturating_add(i32::from(*b - b'0'));
                    i += 1;
                }
                let arg = (i != digits).then_some(if negative { -n } else { n });
                if raw.get(i) == Some(&b' ') {
                    i += 1;
                }
                if word == b"bin" {
                    i = i
                        .checked_add(arg.and_then(|v| usize::try_from(v).ok()).ok_or(BAD)?)
                        .filter(|p| *p <= raw.len())
                        .ok_or(BAD)?;
                }
                if fallback > 0 {
                    fallback -= 1;
                    continue;
                }
                if s.starred {
                    // Encapsulated HTML is text for our passive tokenizer, never markup for a view.
                    s.skip |= !(from_html && word == b"htmltag");
                    s.starred = false;
                }
                s.skip |= skip_destination(word);
                if s.skip {
                    continue;
                }
                match word {
                    b"fromhtml" => from_html = arg.unwrap_or(1) != 0,
                    b"htmlrtf" => s.htmlrtf = arg != Some(0),
                    b"v" => s.hidden = arg != Some(0),
                    b"deleted" => s.deleted = arg != Some(0),
                    b"plain" => s.hidden = false,
                    b"ansicpg" | b"cpg" => {
                        s.codepage = arg.and_then(|v| u32::try_from(v).ok()).ok_or(BAD)?
                    }
                    b"uc" => s.uc = arg.filter(|v| (0..=32).contains(v)).ok_or(BAD)? as usize,
                    b"u" => {
                        let unit = arg.filter(|v| (-32768..=65535).contains(v)).ok_or(BAD)? as u16;
                        if s.visible(from_html) {
                            out.push(unit);
                        }
                        fallback = s.uc;
                    }
                    _ if s.visible(from_html) => {
                        let ch = match word {
                            b"par" | b"line" | b"page" | b"row" => 10,
                            b"tab" | b"cell" => 9,
                            b"emdash" => 0x2014,
                            b"endash" => 0x2013,
                            b"bullet" => 0x2022,
                            b"lquote" => 0x2018,
                            b"rquote" => 0x2019,
                            b"ldblquote" => 0x201c,
                            b"rdblquote" => 0x201d,
                            _ => continue,
                        };
                        out.push(ch);
                    }
                    _ => (),
                }
            }
            _ if fallback > 0 => fallback -= 1,
            _ if s.visible(from_html) => bytes.push(byte),
            _ => (),
        }
    }
    if !stack.is_empty() {
        return Err(BAD.into());
    }
    let text = String::from_utf16(&out).map_err(|_| BAD)?;
    if from_html {
        html::visible(&text)
    } else {
        Ok(text)
    }
}
