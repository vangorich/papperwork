//! HTML tokenizer, not a browser: no DOM, CSS engine, external loads or script execution.
use super::{ansi, decode, Res, MAX_TEXT};
use encoding_rs::Encoding;
use html5ever::{
    tokenizer::{
        states::RawKind, BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
    },
    LocalName,
};
use std::cell::RefCell;

pub(super) fn decode_html(bytes: &[u8], codepage: u32) -> Res<String> {
    if let Some((codec, skip)) = Encoding::for_bom(bytes) {
        return decode(codec, &bytes[skip..]);
    }
    // Outlook's binary PidTagHtml is commonly an Office HTML document with its own charset.
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    for meta in prefix
        .split("<meta")
        .skip(1)
        .filter_map(|s| s.split_once('>').map(|p| p.0))
    {
        if let Some((_, rest)) = meta.split_once("charset") {
            if let Some(value) = rest.trim_start().strip_prefix('=') {
                let value = value.trim_start().trim_start_matches(['\'', '"']);
                let label = value
                    .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .next()
                    .unwrap_or("");
                if let Some(codec) = Encoding::for_label(label.as_bytes()) {
                    return decode(codec, bytes);
                }
            }
        }
    }
    ansi(bytes, codepage)
}

#[derive(Default)]
struct Text {
    value: String,
    space: bool,
    // Each frame inherits its parent's visibility and preformatted flag.
    stack: Vec<(LocalName, bool, bool)>,
    limit_hit: bool,
    emitted: bool,
}
impl Text {
    fn newline(&mut self, explicit: bool) {
        self.space = false;
        if explicit || (!self.value.is_empty() && !self.value.ends_with('\n')) {
            self.value.push('\n');
        }
    }
    fn characters(&mut self, text: &str, pre: bool) {
        for c in text.chars() {
            if !pre && matches!(c, ' ' | '\t' | '\r' | '\n' | '\x0c') {
                self.space = true;
            } else if !c.is_control() || matches!(c, '\n' | '\t') {
                if self.space && !self.value.is_empty() && !self.value.ends_with(['\n', '\t', ' '])
                {
                    self.value.push(' ');
                }
                self.space = false;
                self.value.push(c);
            }
        }
    }
}
struct Sink(RefCell<Text>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut t = self.0.borrow_mut();
        if t.limit_hit {
            return TokenSinkResult::Continue;
        }
        t.emitted |= !matches!(token, Token::ParseError(_));
        // HTML permits common end tags to be omitted, notably </head> before <body>.
        if let (Token::TagToken(tag), Some((top, _, _))) = (&token, t.stack.last()) {
            let name = tag.name.as_ref();
            let implied_end = match top.as_ref() {
                "head" => !matches!(
                    name,
                    "base"
                        | "link"
                        | "meta"
                        | "noscript"
                        | "script"
                        | "style"
                        | "template"
                        | "title"
                ),
                "td" | "th" => matches!(name, "td" | "th"),
                "p" | "li" | "tr" | "option" => *top == tag.name,
                _ => false,
            };
            if tag.kind == TagKind::StartTag && implied_end {
                t.stack.pop();
            }
        }
        let (hidden, pre) = t.stack.last().map(|f| (f.1, f.2)).unwrap_or_default();
        match token {
            Token::CharacterTokens(text) if !hidden => t.characters(&text, pre),
            Token::TagToken(tag) => {
                let name = tag.name.as_ref();
                let block = matches!(
                    name,
                    "p" | "div"
                        | "li"
                        | "ul"
                        | "ol"
                        | "table"
                        | "tr"
                        | "pre"
                        | "section"
                        | "article"
                        | "blockquote"
                        | "hr"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                );
                if tag.kind == TagKind::EndTag {
                    if let Some(pos) = t.stack.iter().rposition(|f| f.0 == tag.name) {
                        t.stack.truncate(pos);
                    }
                    if !hidden && block {
                        t.newline(false);
                    }
                    if !hidden && matches!(name, "td" | "th") {
                        t.space = true;
                    }
                } else {
                    let hidden = hidden
                        || matches!(
                            name,
                            "head"
                                | "title"
                                | "script"
                                | "style"
                                | "template"
                                | "noscript"
                                | "iframe"
                                | "object"
                                | "svg"
                                | "math"
                                | "canvas"
                                | "video"
                                | "audio"
                                | "textarea"
                        )
                        || tag.attrs.iter().any(|attr| match attr.name.local.as_ref() {
                            "hidden" => true,
                            "aria-hidden" => attr.value.trim().eq_ignore_ascii_case("true"),
                            "style" => attr.value.split(';').any(|decl| {
                                decl.split_once(':').is_some_and(|(k, v)| {
                                    let v = v.split('!').next().unwrap_or("").trim();
                                    (k.trim().eq_ignore_ascii_case("display")
                                        && v.eq_ignore_ascii_case("none"))
                                        || (k.trim().eq_ignore_ascii_case("visibility")
                                            && v.eq_ignore_ascii_case("hidden"))
                                        || (k.trim().eq_ignore_ascii_case("mso-hide")
                                            && v.eq_ignore_ascii_case("all"))
                                })
                            }),
                            _ => false,
                        });
                    if !hidden && (name == "br" || block) {
                        t.newline(name == "br");
                    }
                    let void = matches!(
                        name,
                        "area"
                            | "base"
                            | "br"
                            | "col"
                            | "embed"
                            | "hr"
                            | "img"
                            | "input"
                            | "link"
                            | "meta"
                            | "param"
                            | "source"
                            | "track"
                            | "wbr"
                    ) || (tag.self_closing && matches!(name, "svg" | "math"));
                    if !void {
                        if t.stack.len() == 128 {
                            t.limit_hit = true;
                            return TokenSinkResult::Continue;
                        }
                        t.stack
                            .push((tag.name.clone(), hidden, pre || name == "pre"));
                    }
                    match name {
                        "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
                        "style" | "iframe" | "noscript" => {
                            return TokenSinkResult::RawData(RawKind::Rawtext)
                        }
                        "title" | "textarea" => return TokenSinkResult::RawData(RawKind::Rcdata),
                        _ => (),
                    }
                }
            }
            _ => (),
        }
        t.limit_hit |= t.value.len() > MAX_TEXT;
        TokenSinkResult::Continue
    }
}

pub(super) fn visible(html: &str) -> Res<String> {
    if html.len() > MAX_TEXT {
        return Err("MSG HTML 正文过长".into());
    }
    let input = BufferQueue::default();
    let tokenizer = Tokenizer::new(Sink(RefCell::default()), Default::default());
    let mut rest = html;
    let mut pending_delimiters = 0;
    while !rest.is_empty() {
        let mut end = rest.len().min(2048);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, next) = rest.split_at(end);
        rest = next;
        tokenizer.sink.0.borrow_mut().emitted = false;
        input.push_back(chunk.into());
        let _ = tokenizer.feed(&input);
        let state = tokenizer.sink.0.borrow();
        if state.limit_hit {
            return Err("MSG HTML 正文长度或嵌套层级超出限制".into());
        }
        if state.emitted {
            pending_delimiters = 0;
        } else {
            // Bound repeated attribute comparisons inside a single unfinished token, before
            // html5ever delivers the tag. Ordinary long text emits tokens as each chunk arrives.
            pending_delimiters += chunk
                .bytes()
                .filter(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'=' | b'\'' | b'"'))
                .count();
            if pending_delimiters > 1024 {
                return Err("MSG HTML 标记过长或属性过多".into());
            }
        }
    }
    tokenizer.end();
    let t = tokenizer.sink.0.into_inner();
    if t.limit_hit {
        return Err("MSG HTML 正文长度或嵌套层级超出限制".into());
    }
    Ok(t.value.trim_end_matches([' ', '\n', '\t']).to_owned())
}
