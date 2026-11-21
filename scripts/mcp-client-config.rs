//! Transient Windows installer helper, never the MCP server. No ambient profile fallback.
//! install|refresh|uninstall PROFILE LOCALAPPDATA GUI_EXE; exit 2 = at least one skipped client.
#[path = "mcp-client-config.edit.rs"]
mod edit;
#[path = "mcp-client-config.fs.rs"]
mod files;
#[cfg(test)]
#[path = "../tests/mcp-client-config-transaction.rs"]
mod transaction_tests;

use files::{local_path, optional, pin, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
};
use uuid::Uuid;

type Result<T> = io::Result<T>;
fn bad(msg: &'static str) -> io::Error {
    io::Error::other(msg)
}
const KEY: &str = "paperwork-pdf";
const ARG: &str = "--pdf-mcp";
const OWNER: &str = "PAPERWORK_MCP_REGISTRATION"; // Ownership only; never a document grant.
const STATE: &str = "studio.paperwork.pdf-mcp-receipts";
const MAX_CONFIG: u64 = 16 << 20;
#[derive(Copy, Clone, PartialEq)]
enum Mode {
    Install,
    Refresh,
    Uninstall,
}
#[derive(Copy, Clone)]
enum Format {
    Json,
    Toml,
}
impl Format {
    fn empty(self) -> &'static str {
        match self {
            Self::Json => "{}\n",
            Self::Toml => "",
        }
    }
}
struct Client {
    name: &'static str,
    directory: &'static str,
    config: &'static str,
    format: Format,
}
const CLIENTS: [Client; 3] = [
    Client {
        name: "Claude Code",
        directory: ".claude",
        config: ".claude.json",
        format: Format::Json,
    },
    Client {
        name: "Codex",
        directory: ".codex",
        config: ".codex/config.toml",
        format: Format::Toml,
    },
    Client {
        name: "Gemini CLI",
        directory: ".gemini",
        config: ".gemini/settings.json",
        format: Format::Json,
    },
];
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Receipt {
    config: PathBuf,
    command: String,
    id: Uuid,
    created_file: bool,
    added_container: bool,
    original_before_separator: Option<[u8; 32]>,
}

fn apply(c: &Client, mode: Mode, home: &Path, local: &Path, exe: &str) -> Result<&'static str> {
    let config = home.join(c.config);
    let state = local.join(STATE);
    let receipt = state.join(format!("{}.json", c.directory.trim_start_matches('.')));
    let mut state_pin = optional(pin(&state))?;
    if state_pin.is_none() && mode != Mode::Install {
        return Ok("not registered");
    }
    let tx = Transaction::new()?;
    let mut receipt_file = if state_pin.is_some() {
        optional(tx.open(&receipt, false))?
    } else {
        None
    };
    let old: Option<Receipt> = receipt_file
        .as_mut()
        .map(|f| -> Result<Receipt> {
            let r: Receipt = serde_json::from_str(&files::read(f, 32 << 10)?)
                .map_err(|_| bad("invalid ownership receipt"))?;
            if r.config != config || !local_path(Path::new(&r.command)) {
                return Err(bad("invalid receipt binding"));
            }
            Ok(r)
        })
        .transpose()?;
    if old.is_none() && mode != Mode::Install {
        return Ok("not registered");
    }
    if mode == Mode::Uninstall && old.as_ref().is_some_and(|r| r.command != exe) {
        return Ok("belongs to another install path");
    }

    // Only existing default profiles count as detection. In particular a clean home
    // does not acquire .claude/.codex/.gemini directories, settings or a receipt.
    let profile_pin = optional(pin(&home.join(c.directory)))?;
    let mut file = if config.parent() == Some(home) || profile_pin.is_some() {
        optional(tx.open(&config, false))?
    } else {
        None
    };
    if file.is_none() && old.is_some() {
        if mode == Mode::Uninstall {
            drop(receipt_file);
            tx.delete(&receipt)?;
            tx.commit()?;
            return Ok("removed obsolete receipt");
        }
        return Err(bad("previously registered config is missing"));
    }
    if file.is_none() && profile_pin.is_none() {
        return Ok("not detected");
    }
    let text = match &mut file {
        Some(f) => files::read(f, MAX_CONFIG)?,
        None => c.format.empty().into(),
    };
    let mut next = old.clone().unwrap_or_else(|| Receipt {
        config: config.clone(),
        command: String::new(),
        id: Uuid::new_v4(),
        created_file: file.is_none(),
        added_container: false,
        original_before_separator: None,
    });
    next.command = exe.into();
    let updated = edit::edit(&text, c.format, mode, old.as_ref(), &mut next)?;
    if updated.len() as u64 > MAX_CONFIG {
        return Err(bad("updated config would exceed size limit"));
    }
    if updated == text && mode != Mode::Uninstall {
        return Ok("already current");
    }
    if mode == Mode::Uninstall && next.created_file && updated == c.format.empty() {
        drop(file);
        tx.delete(&config)?;
    } else {
        let mut f = match file {
            Some(f) => f,
            None => tx.open(&config, true)?,
        };
        files::write(&mut f, updated.as_bytes())?;
    }
    if mode == Mode::Uninstall {
        drop(receipt_file);
        tx.delete(&receipt)?;
    } else {
        if state_pin.is_none() {
            match fs::create_dir(&state) {
                Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
                _ => (),
            }
            state_pin = Some(pin(&state)?);
        }
        let mut f = match receipt_file {
            Some(f) => f,
            None => tx.open(&receipt, true)?,
        };
        files::write(&mut f, &serde_json::to_vec(&next)?)?;
    }
    tx.commit()?;
    drop(state_pin);
    drop(profile_pin);
    Ok(if mode == Mode::Uninstall {
        "unregistered"
    } else {
        "registered"
    })
}

fn run() -> Result<ExitCode> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let [op, home, local, exe] = args.as_slice() else {
        return Err(bad(
            "expected mode, profile, local app data and GUI executable",
        ));
    };
    let mode = match op.to_str() {
        Some("install") => Mode::Install,
        Some("refresh") => Mode::Refresh,
        Some("uninstall") => Mode::Uninstall,
        _ => return Err(bad("unknown mode")),
    };
    let (home, local, exe) = (Path::new(home), Path::new(local), Path::new(exe));
    if [home, local, exe].into_iter().any(|p| !local_path(p))
        || !exe
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    {
        return Err(bad("absolute local paths and a GUI .exe are required"));
    }
    if mode != Mode::Uninstall && !fs::metadata(exe)?.is_file() {
        return Err(bad("missing GUI executable"));
    }
    let mut roots = Vec::new();
    for dir in [home, local] {
        for ancestor in dir.ancestors().collect::<Vec<_>>().into_iter().rev() {
            roots.push(pin(ancestor)?);
        }
    }
    let exe = exe.to_str().ok_or(bad("executable path is not Unicode"))?;
    let mut status = ExitCode::SUCCESS;
    for client in CLIENTS {
        match apply(&client, mode, home, local, exe) {
            Ok(action) => println!("{}: {action}", client.name),
            Err(e) => {
                println!("{}: skipped ({e})", client.name);
                status = ExitCode::from(2);
            }
        }
    }
    Ok(status)
}
fn main() -> ExitCode {
    run().unwrap_or_else(|e| {
        eprintln!("MCP registration skipped: {e}");
        ExitCode::FAILURE
    })
}
