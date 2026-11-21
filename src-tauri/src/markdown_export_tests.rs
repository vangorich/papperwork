use super::*;
use tempfile::tempdir;

// One blue RGBA pixel, encoded as a complete PNG (including CRCs and IEND).
const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 4, 115, 66, 73, 84, 8, 8, 8, 8, 124, 8, 100, 136, 0, 0, 0, 1,
    115, 82, 71, 66, 0, 174, 206, 28, 233, 0, 0, 0, 13, 73, 68, 65, 84, 8, 153, 99, 96, 72, 251,
    255, 31, 0, 4, 52, 2, 101, 245, 64, 175, 96, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

#[test]
fn native_write_errors_do_not_reveal_picked_paths_to_export_status() {
    let path = r"C:\Private\my-document.md";
    for kind in [
        io::ErrorKind::PermissionDenied,
        io::ErrorKind::AlreadyExists,
        io::ErrorKind::Other,
    ] {
        assert!(!err(io::Error::new(kind, path)).contains(path));
    }
}

#[test]
fn standalone_is_utf8_atomic_and_one_shot() {
    let temp = tempdir().unwrap();
    let file = temp.path().join("书稿.md");
    let state = MarkdownExports::default();
    let ticket = state.issue(&file, false).unwrap();
    assert_eq!(ticket.name, "书稿.md");
    assert!(ticket.asset_directory.is_empty());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    let md = "## 第 1 页\n\n原稿。\n".as_bytes();
    state.finish(&ticket.token, md).unwrap();
    assert_eq!(fs::read(&file).unwrap(), md);
    assert!(!state.lock().unwrap().contains_key(&ticket.token));
    assert!(state.finish(&ticket.token, b"different").is_err());
    assert!(state.issue(&file, true).is_err());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn chooser_name_and_collision_suffix_resolve_to_the_exact_image_bytes() {
    let temp = tempdir().unwrap();
    let folder = temp.path().join("renamed-images");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("figure-001.png"), b"unrelated previous export").unwrap();
    fs::write(temp.path().join("renamed-images-2"), b"unrelated file").unwrap();
    let path = temp.path().join("renamed.md");
    let state = MarkdownExports::default();
    let t = state.issue(&path, true).unwrap();
    assert_eq!(t.asset_directory, "renamed-images-3");
    let relative = format!("{}/figure-001.png", t.asset_directory);
    state.image(&t.token, "figure-001.png", PNG).unwrap();
    assert!(!path.exists()); // A Markdown reader never sees a half-written export.
    state
        .finish(&t.token, format!("![blue]({relative})\n").as_bytes())
        .unwrap();
    let md = fs::read_to_string(path).unwrap();
    let link = md
        .trim()
        .strip_prefix("![blue](")
        .unwrap()
        .strip_suffix(')')
        .unwrap();
    assert_eq!(fs::read(temp.path().join(link)).unwrap(), PNG);
    assert_eq!(
        fs::read(folder.join("figure-001.png")).unwrap(),
        b"unrelated previous export"
    );
    assert_eq!(
        fs::read(temp.path().join("renamed-images-2")).unwrap(),
        b"unrelated file"
    );
}

#[test]
fn cancel_and_failed_commit_do_not_delete_unrelated_data() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("notes.md");
    let state = MarkdownExports::default();
    let t = state.issue(&path, true).unwrap();
    let assets = temp.path().join(&t.asset_directory);
    state.image(&t.token, "figure-001.png", PNG).unwrap();
    fs::write(assets.join("keep.txt"), b"independent").unwrap();
    state.cancel(&t.token).unwrap();
    assert!(!path.exists());
    assert!(!assets.join("figure-001.png").exists());
    assert_eq!(fs::read(assets.join("keep.txt")).unwrap(), b"independent");
    assert!(state.finish(&t.token, b"expired").is_err());

    let t = state.issue(&path, true).unwrap();
    let other = temp.path().join(&t.asset_directory);
    state.image(&t.token, "figure-001.png", PNG).unwrap();
    fs::write(&path, b"created while chooser was open").unwrap();
    assert!(state.finish(&t.token, b"new contents").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"created while chooser was open");
    assert!(!other.exists());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn invalid_assets_and_text_roll_back_without_writing_outside_the_grant() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("copy.md");
    let outside = temp.path().join("other.png");
    fs::write(&outside, b"sentinel").unwrap();
    let state = MarkdownExports::default();
    for (name, bytes) in [
        ("../other.png", PNG),
        ("C:\\other.png", PNG),
        ("AUX.png", PNG),
        ("x:other.png", PNG),
        ("file.cmd", PNG),
        ("figure.png", b"not a PNG".as_slice()),
        ("figure-001.png", PNG),
    ] {
        let t = state.issue(&path, true).unwrap();
        state.image(&t.token, "figure-001.png", PNG).unwrap();
        assert!(state.image(&t.token, name, bytes).is_err());
        assert!(state.finish(&t.token, b"expired").is_err());
        assert!(!temp.path().join(t.asset_directory).exists());
    }
    let t = state.issue(&path, false).unwrap();
    assert!(state.image(&t.token, "figure.png", PNG).is_err());
    let t = state.issue(&path, true).unwrap();
    assert!(state.finish(&t.token, &[0xff]).is_err());
    assert!(!path.exists());
    assert_eq!(fs::read(outside).unwrap(), b"sentinel");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    for name in [
        "../bad.md",
        "C:\\redirect.md",
        "NUL.md",
        "LPT¹.md",
        "x.pdf:other.md",
        ".md",
        "app.exe",
    ] {
        assert!(!markdown_leaf(name), "{name}");
    }
}

#[cfg(windows)]
#[test]
fn windows_cannot_swap_the_directory_out_from_under_a_live_ticket() {
    let temp = tempdir().unwrap();
    let host = temp.path().join("picked");
    fs::create_dir(&host).unwrap();
    let state = MarkdownExports::default();
    let t = state.issue(&host.join("test.md"), true).unwrap();
    let dir = host.join(&t.asset_directory);
    assert!(fs::rename(&host, temp.path().join("moved")).is_err());
    assert!(fs::rename(&dir, host.join("moved-images")).is_err());
    state.cancel(&t.token).unwrap();
    assert!(!dir.exists());
    fs::rename(host, temp.path().join("released")).unwrap();
}
