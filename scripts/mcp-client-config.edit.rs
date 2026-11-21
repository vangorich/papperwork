//! Only splice source ranges belonging to our entry. Never serialize an entire client file.
use super::{bad, Format, Mode, Receipt, Result, ARG, KEY, OWNER};
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Deserializer};
use sha2::{Digest, Sha256};
use std::ops::Range;
use toml_edit::{Document, Item, Table};
use uuid::Uuid;

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Env {
    #[serde(rename = "PAPERWORK_MCP_REGISTRATION")]
    registration: Uuid,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Server<'a> {
    command: std::borrow::Cow<'a, str>,
    args: [String; 1],
    env: Env,
}
impl<'a> From<&'a Receipt> for Server<'a> {
    fn from(r: &'a Receipt) -> Self {
        Self {
            command: r.command.as_str().into(),
            args: [ARG.into()],
            env: Env { registration: r.id },
        }
    }
}

struct Member {
    name: String,
    key: usize,
    value: Range<usize>,
}
struct Object {
    open: usize,
    fields: Vec<Member>,
}

fn space(s: &str, pos: usize) -> usize {
    s.len() - s[pos..].trim_start_matches([' ', '\t', '\r', '\n']).len()
}
fn splice(s: &str, range: Range<usize>, content: &str) -> String {
    let mut out = s.to_owned();
    out.replace_range(range, content);
    out
}

impl Object {
    // The full document was validated first. Let serde_json delimit escaped keys and
    // arbitrary nested values; neither substring matching nor a second JSON grammar is needed.
    fn at(s: &str, pos: usize) -> Result<Self> {
        let open = space(s, pos);
        if s.as_bytes().get(open) != Some(&b'{') {
            return Err(bad("expected a JSON object"));
        }
        let mut fields = Vec::new();
        let mut key = space(s, open + 1);
        while s.as_bytes().get(key) != Some(&b'}') {
            let mut keys = Deserializer::from_str(&s[key..]).into_iter::<String>();
            let name = keys.next().ok_or(bad("missing key"))??;
            let colon = space(s, key + keys.byte_offset());
            let start = space(s, colon + 1);
            let raw = Deserializer::from_str(&s[start..])
                .into_iter::<&RawValue>()
                .next()
                .ok_or(bad("missing value"))??;
            let end = start + raw.get().len();
            fields.push(Member {
                name,
                key,
                value: start..end,
            });
            let comma = space(s, end);
            if s.as_bytes().get(comma) != Some(&b',') {
                break;
            }
            key = space(s, comma + 1);
        }
        Ok(Self { open, fields })
    }
    fn which(&self, name: &str) -> Result<Option<usize>> {
        let mut found = None;
        for (i, m) in self
            .fields
            .iter()
            .enumerate()
            .filter(|(_, m)| m.name.eq_ignore_ascii_case(name))
        {
            if found.is_some() || m.name != name {
                return Err(bad("ambiguous config key"));
            }
            found = Some(i);
        }
        Ok(found)
    }
    fn insert(&self, s: &str, pair: &str) -> String {
        let at = self.fields.last().map_or(self.open + 1, |m| m.value.end);
        let comma = if self.fields.is_empty() { "" } else { "," };
        splice(s, at..at, &format!("{comma}{pair}"))
    }
    fn remove(&self, s: &str, i: usize) -> String {
        let m = &self.fields[i];
        let range = if i > 0 {
            space(s, self.fields[i - 1].value.end)..m.value.end
        } else if let Some(next) = self.fields.get(1) {
            m.key..next.key
        } else {
            m.key..m.value.end
        };
        splice(s, range, "")
    }
}

fn json(s: &str, mode: Mode, old: Option<&Receipt>, next: &mut Receipt) -> Result<String> {
    serde_json::from_str::<serde_json::Value>(s).map_err(|_| bad("invalid JSON"))?;
    let root = Object::at(s, 0)?;
    let parent = root.which("mcpServers")?;
    let servers = parent
        .map(|i| Object::at(s, root.fields[i].value.start))
        .transpose()?;
    let i = servers
        .as_ref()
        .map(|o| o.which(KEY))
        .transpose()?
        .flatten();
    let Some(old) = old else {
        if i.is_some() {
            return Err(bad("server name already in use"));
        }
        let pair = format!(
            "\"{KEY}\":{}",
            serde_json::to_string(&Server::from(&*next))?
        );
        next.added_container = servers.is_none();
        return Ok(match servers {
            Some(o) => o.insert(s, &pair),
            None => root.insert(s, &format!("\"mcpServers\":{{{pair}}}")),
        });
    };
    let (Some(parent), Some(servers), Some(i)) = (parent, servers, i) else {
        return Err(bad("owned entry no longer present"));
    };
    let range = servers.fields[i].value.clone();
    let current: Server =
        serde_json::from_str(&s[range.clone()]).map_err(|_| bad("user-modified server entry"))?;
    if current != Server::from(old) {
        return Err(bad("user-modified server entry"));
    }
    if mode == Mode::Uninstall {
        return Ok(if old.added_container && servers.fields.len() == 1 {
            root.remove(s, parent)
        } else {
            servers.remove(s, i)
        });
    }
    if old.command == next.command {
        return Ok(s.into());
    }
    let server = Object::at(s, range.start)?;
    let command = server.which("command")?.ok_or(bad("missing command"))?;
    Ok(splice(
        s,
        server.fields[command].value.clone(),
        &serde_json::to_string(&next.command)?,
    ))
}

// Preserve comments, even a user's inline comment on an owned assignment. Refuse
// unfamiliar multiline layouts rather than deleting comments embedded in a value.
fn whole_line(s: &str, span: Range<usize>) -> Result<Range<usize>> {
    let start = s[..span.start].rfind('\n').map_or(0, |i| i + 1);
    let end = s[span.end..]
        .find('\n')
        .map_or(s.len(), |i| span.end + i + 1);
    if !s[start..span.start].trim().is_empty() || s[span.clone()].contains('\n') {
        return Err(bad("non-standalone TOML field"));
    }
    let rest = &s[span.end..end];
    if rest.trim().is_empty() {
        Ok(start..end)
    } else if rest.trim_start().starts_with('#') {
        Ok(start..span.end)
    } else {
        Err(bad("unrecognized TOML field layout"))
    }
}
fn field_span(table: &Table, name: &str) -> Result<Range<usize>> {
    let key = table
        .key(name)
        .and_then(|k| k.span())
        .ok_or(bad("missing TOML key span"))?;
    let value = table
        .get(name)
        .and_then(Item::span)
        .ok_or(bad("missing TOML value span"))?;
    Ok(key.start..value.end)
}
fn header(s: &str, table: &Table) -> Result<Range<usize>> {
    let h = table.span().ok_or(bad("implicit TOML table"))?;
    if !s[h.clone()].starts_with('[') {
        return Err(bad("implicit TOML table"));
    }
    whole_line(s, h)
}
fn toml(s: &str, mode: Mode, old: Option<&Receipt>, next: &mut Receipt) -> Result<String> {
    let doc = Document::parse(s).map_err(|_| bad("invalid TOML"))?;
    let parent = doc
        .get("mcp_servers")
        .map(|v| v.as_table_like().ok_or(bad("invalid mcp_servers table")))
        .transpose()?;
    let entry = parent.and_then(|v| v.get(KEY));
    let command = serde_json::to_string(&next.command)?; // Windows paths use a shared subset of basic string escapes.
    let Some(old) = old else {
        if parent.is_some_and(|t| t.iter().any(|(k, _)| k.eq_ignore_ascii_case(KEY))) {
            return Err(bad("server name already in use"));
        }
        let eol = if s.contains("\r\n") { "\r\n" } else { "\n" };
        // A later editor may insert its own blank line here. Keep only a digest,
        // not a backup containing unrelated client commands, credentials or comments.
        next.original_before_separator =
            (!s.is_empty() && !s.ends_with('\n')).then(|| Sha256::digest(s.as_bytes()).into());
        let pad = if next.original_before_separator.is_some() {
            eol
        } else {
            ""
        };
        let out = format!("{s}{pad}[mcp_servers.{KEY}]{eol}command = {command}{eol}args = [\"{ARG}\"]{eol}env = {{ {OWNER} = \"{}\" }}{eol}", next.id);
        // Inline/dotted parents can be sealed; never commit an invalid extension.
        Document::parse(out.as_str()).map_err(|_| bad("TOML table cannot be extended"))?;
        return Ok(out);
    };
    let table = entry
        .and_then(Item::as_table)
        .ok_or(bad("owned TOML table missing or changed"))?;
    let args = table.get("args").and_then(Item::as_array);
    let env = table.get("env").and_then(Item::as_table_like);
    if table.len() != 3
        || table.get("command").and_then(Item::as_str) != Some(&old.command)
        || !args.is_some_and(|a| a.len() == 1 && a.get(0).and_then(|v| v.as_str()) == Some(ARG))
        || !env.is_some_and(|e| {
            e.len() == 1 && e.get(OWNER).and_then(Item::as_str) == Some(&old.id.to_string())
        })
    {
        return Err(bad("user-modified TOML entry"));
    }
    if mode != Mode::Uninstall {
        if old.command == next.command {
            return Ok(s.into());
        }
        return Ok(splice(
            s,
            table["command"].span().ok_or(bad("missing command span"))?,
            &command,
        ));
    }
    let title = header(s, table)?;
    let mut lines = vec![
        title.clone(),
        whole_line(s, field_span(table, "command")?)?,
        whole_line(s, field_span(table, "args")?)?,
    ];
    if let Some(sub) = table["env"].as_table() {
        lines.extend([header(s, sub)?, whole_line(s, field_span(sub, OWNER)?)?]);
    } else {
        lines.push(whole_line(s, field_span(table, "env")?)?);
    }
    lines.sort_by_key(|r| r.start);
    if lines.windows(2).any(|w| w[0].end > w[1].start) {
        return Err(bad("overlapping TOML fields"));
    }
    // If the client has moved a subtable or added comments, an equal byte count is
    // not evidence that its final newline was ours. Strip only a contiguous owned suffix.
    let owned_suffix = lines.first().is_some_and(|r| r.start == title.start)
        && lines.windows(2).all(|w| w[0].end == w[1].start)
        && lines.last().is_some_and(|r| r.end == s.len());
    let mut out = s.to_owned();
    for line in lines.into_iter().rev() {
        out.replace_range(line, "");
    }
    if let Some(original) = old.original_before_separator.filter(|_| owned_suffix) {
        if let Some(prefix) = out.strip_suffix("\r\n").or_else(|| out.strip_suffix('\n')) {
            if <[u8; 32]>::from(Sha256::digest(prefix.as_bytes())) == original {
                out.truncate(prefix.len());
            }
        }
    }
    let checked =
        Document::parse(out.as_str()).map_err(|_| bad("cannot remove TOML table safely"))?;
    if checked
        .get("mcp_servers")
        .and_then(|p| p.get(KEY))
        .is_some()
    {
        return Err(bad("ambiguous TOML table"));
    }
    Ok(out)
}

pub fn edit(
    s: &str,
    format: Format,
    mode: Mode,
    old: Option<&Receipt>,
    next: &mut Receipt,
) -> Result<String> {
    let (bom, s) = s
        .strip_prefix('\u{feff}')
        .map_or(("", s), |text| ("\u{feff}", text));
    let mut out = match format {
        Format::Json => json(s, mode, old, next)?,
        Format::Toml => toml(s, mode, old, next)?,
    };
    out.insert_str(0, bom);
    Ok(out)
}
