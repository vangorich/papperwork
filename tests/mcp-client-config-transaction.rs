use super::files::{read, write, Transaction};
use std::{env, fs};
use uuid::Uuid;

#[test]
fn racing_rename_and_write_cannot_interpose_between_read_and_commit_or_rollback() {
    let root = env::temp_dir().join(format!("paperwork-tx-test-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let config = root.join("synthetic.json");
    let racing = root.join("racing.json");
    let receipt = root.join("receipt.json");
    fs::write(&config, b"original").unwrap();
    fs::write(&racing, b"other writer").unwrap();
    // The uninstaller drops the inspected handle before a transacted delete by name.
    // Even with no write yet, the transaction still owns that exact file.
    let inspected = Transaction::new().unwrap();
    assert_eq!(
        read(&mut inspected.open(&config, false).unwrap(), 100).unwrap(),
        "original"
    );
    assert!(fs::rename(&racing, &config).is_err());
    drop(inspected);
    for commit in [false, true] {
        let tx = Transaction::new().unwrap();
        let mut f = tx.open(&config, false).unwrap();
        assert_eq!(read(&mut f, 100).unwrap(), "original");
        assert!(fs::rename(&racing, &config).is_err());
        write(&mut f, b"replacement").unwrap();
        drop(f);
        write(&mut tx.open(&receipt, true).unwrap(), b"proof").unwrap();
        assert_eq!(fs::read(&config).unwrap(), b"original");
        assert!(!receipt.exists());
        assert!(fs::write(&config, b"interleaved").is_err());
        assert!(fs::rename(&racing, &config).is_err());
        if commit {
            tx.commit().unwrap();
            assert_eq!(fs::read(&config).unwrap(), b"replacement");
            assert_eq!(fs::read(&receipt).unwrap(), b"proof");
        } else {
            drop(tx); // The same rollback path as a failed or terminated installer.
            assert_eq!(fs::read(&config).unwrap(), b"original");
            assert!(!receipt.exists());
        }
    }
    fs::rename(&racing, &config).unwrap();
    fs::remove_dir_all(root).unwrap();
}
