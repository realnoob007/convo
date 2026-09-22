use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

// Kept separate from projects so project history/export cannot include keys.
static DATABASE: OnceLock<CredentialStore> = OnceLock::new();
struct CredentialStore {
    path: PathBuf,
}
impl CredentialStore {
    fn open(path: &Path) -> Result<Self, String> {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| "Could not open API key database")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Could not protect API key database")?;
        }
        drop(file);
        let db = Connection::open(path).map_err(|_| "Could not open API key database")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS credentials (
            provider TEXT PRIMARY KEY CHECK(provider IN ('openai', 'elevenlabs')),
            api_key TEXT NOT NULL CHECK(length(api_key) > 0)
        );
        CREATE TABLE IF NOT EXISTS text_connection (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, api_key TEXT NOT NULL);",
        )
        .map_err(|_| "Could not initialize API key database")?;
        Ok(Self {
            path: path.to_owned(),
        })
    }
    fn connection(&self) -> Result<Option<(String, String)>, String> {
        let db = Connection::open(&self.path).map_err(|_| "Could not open API key database")?;
        db.query_row(
            "SELECT config, api_key FROM text_connection WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| "Could not read text connection".into())
    }
    fn save_connection(&self, config: &str, key: &str) -> Result<(), String> {
        let db = Connection::open(&self.path).map_err(|_| "Could not open API key database")?;
        db.execute("INSERT INTO text_connection VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET config=excluded.config, api_key=excluded.api_key", params![config,key])
            .map_err(|_| "Could not save text connection")?;
        Ok(())
    }
    fn read(&self, provider: &str) -> Result<String, String> {
        validate_provider(provider)?;
        let db = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "Could not open API key database")?;
        let key: Option<String> = db
            .query_row(
                "SELECT api_key FROM credentials WHERE provider=?1",
                [provider],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Could not read saved API key")?;
        key.ok_or_else(|| format!("Add your {provider} API key in Settings"))
    }
    fn save(&self, provider: &str, key: &str) -> Result<(), String> {
        validate_provider(provider)?;
        let key = key.trim();
        if key.is_empty() {
            return Err("Enter an API key".into());
        }
        let db = Connection::open(&self.path).map_err(|_| "Could not open API key database")?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Could not open API key database")?;
        db.execute(
            "INSERT INTO credentials(provider, api_key) VALUES (?1,?2)
            ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key",
            params![provider, key],
        )
        .map_err(|_| "Could not save API key to local database")?;
        Ok(())
    }
}
fn validate_provider(provider: &str) -> Result<(), String> {
    if ["openai", "elevenlabs"].contains(&provider) {
        Ok(())
    } else {
        Err("Unknown provider".into())
    }
}
pub fn initialize(root: &Path) -> Result<(), String> {
    let store = CredentialStore::open(&root.join("credentials.sqlite3"))?;
    DATABASE
        .set(store)
        .map_err(|_| "API key database already initialized".into())
}
pub fn read(provider: &str) -> Result<String, String> {
    DATABASE
        .get()
        .ok_or("API key database unavailable")?
        .read(provider)
}
pub fn save(provider: &str, key: &str) -> Result<(), String> {
    DATABASE
        .get()
        .ok_or("API key database unavailable")?
        .save(provider, key)
}
pub fn connection() -> Result<Option<(String, String)>, String> {
    DATABASE
        .get()
        .ok_or("API key database unavailable")?
        .connection()
}
pub fn save_connection(config: &str, key: &str) -> Result<(), String> {
    DATABASE
        .get()
        .ok_or("API key database unavailable")?
        .save_connection(config, key)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_is_persistent_and_separate_from_legacy_keys() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("credentials.sqlite3");
        let store = CredentialStore::open(&path).unwrap();
        assert!(store.connection().unwrap().is_none());
        store.save("openai", "original").unwrap();
        store.save_connection("config", "custom-key").unwrap();
        assert_eq!(
            CredentialStore::open(&path).unwrap().connection().unwrap(),
            Some(("config".into(), "custom-key".into()))
        );
        assert_eq!(store.read("openai").unwrap(), "original");
    }
    #[test]
    fn keys_survive_reopen_and_updates_without_operating_system_vault() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("credentials.sqlite3");
        let store = CredentialStore::open(&path).unwrap();
        assert!(store.read("openai").is_err());
        store.save("openai", "  test-openai  ").unwrap();
        store.save("elevenlabs", "test-elevenlabs").unwrap();
        let reopened = CredentialStore::open(&path).unwrap();
        assert_eq!(reopened.read("openai").unwrap(), "test-openai");
        reopened.save("openai", "replacement").unwrap();
        assert_eq!(store.read("openai").unwrap(), "replacement");
        assert_eq!(reopened.read("elevenlabs").unwrap(), "test-elevenlabs");
        assert!(store.save("openai", " ").is_err());
        assert!(store.save("unsupported", "value").is_err());
        assert_eq!(store.read("openai").unwrap(), "replacement");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
