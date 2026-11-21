use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Application-owned data only. Neither SQL nor persisted paths are callable from JS.
pub(crate) struct Database(Mutex<Connection>);

#[derive(Debug, PartialEq)]
pub(crate) struct Bounds {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Database {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut db = Connection::open(path)?;
        db.pragma_update(None, "foreign_keys", true)?;
        let version: i32 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        match version {
            0 => {
                let tx = db.transaction()?;
                tx.execute_batch("CREATE TABLE picker_directory (
                    purpose TEXT PRIMARY KEY CHECK(purpose IN ('open','save','folder')),
                    directory TEXT NOT NULL
                ) WITHOUT ROWID;
                CREATE TABLE window_geometry (
                    id INTEGER PRIMARY KEY CHECK(id = 1), x INTEGER, y INTEGER,
                    width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
                    maximized INTEGER NOT NULL CHECK(maximized IN (0,1))
                ); PRAGMA user_version = 1;")?;
                tx.commit()?;
            }
            1 => (),
            _ => return Err(rusqlite::Error::InvalidQuery), // Never downgrade a newer profile.
        }
        Ok(Self(Mutex::new(db)))
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        match self.0.lock().ok().map(|db| f(&db))? {
            Ok(value) => Some(value),
            Err(error) => {
                eprintln!("无法读取或保存桌面偏好：{error}");
                None
            }
        }
    }

    pub fn picker(&self, purpose: &str) -> Option<PathBuf> {
        let directory = self.with(|db| {
            db.query_row(
                "SELECT directory FROM picker_directory WHERE purpose=?",
                [purpose],
                |r| r.get::<_, String>(0),
            )
            .optional()
        })??;
        let path = PathBuf::from(directory);
        path.is_dir().then_some(path)
    }

    pub fn remember_picker(&self, purpose: &str, directory: &Path) {
        self.with(|db| db.execute("INSERT INTO picker_directory VALUES (?1,?2) ON CONFLICT(purpose) DO UPDATE SET directory=excluded.directory", params![purpose, directory.to_string_lossy()]));
    }

    pub fn bounds(&self) -> Option<Bounds> {
        self.with(|db| {
            db.query_row(
                "SELECT x,y,width,height,maximized FROM window_geometry WHERE id=1",
                [],
                |r| {
                    Ok(Bounds {
                        x: r.get(0)?,
                        y: r.get(1)?,
                        width: r.get(2)?,
                        height: r.get(3)?,
                        maximized: r.get(4)?,
                    })
                },
            )
            .optional()
        })
        .flatten()
    }

    pub fn remember_bounds(&self, b: &Bounds) {
        self.with(|db| db.execute("INSERT OR REPLACE INTO window_geometry (id,x,y,width,height,maximized) VALUES (1,?1,?2,?3,?4,?5)", params![b.x,b.y,b.width,b.height,b.maximized]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_defaults_are_absent_and_choices_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile.sqlite3");
        let db = Database::open(&path).unwrap();
        assert!(db.bounds().is_none() && db.picker("open").is_none());
        let b = Bounds {
            x: Some(-850),
            y: Some(16),
            width: 1050,
            height: 730,
            maximized: false,
        };
        db.remember_bounds(&b);
        db.remember_picker("open", dir.path());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.picker("open").as_deref(), Some(dir.path()));
        assert_eq!(db.bounds(), Some(b));
        assert_eq!(
            db.with(|db| db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)))
                .as_deref(),
            Some("ok")
        );
        assert_eq!(
            db.with(
                |db| db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
            ),
            Some(0)
        );
    }

    #[test]
    fn failed_migration_rolls_back_and_a_newer_profile_is_not_modified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile.sqlite3");
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch("CREATE TABLE window_geometry (keep TEXT); INSERT INTO window_geometry VALUES ('original');").unwrap();
        assert!(Database::open(&path).is_err());
        let count: i64 = raw
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='picker_directory'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        raw.pragma_update(None, "user_version", 2).unwrap();
        assert!(Database::open(&path).is_err());
        assert_eq!(
            raw.query_row("SELECT keep FROM window_geometry", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "original"
        );
    }
}
