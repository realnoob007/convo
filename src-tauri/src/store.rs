use crate::domain::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Store {
    pub db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 2 {
            return Err("This database needs a newer version of Convo".into());
        }
        if version == 1 && path != Path::new(":memory:") {
            let backup = path.with_extension(format!("v1-{}.backup.sqlite3", uuid::Uuid::new_v4()));
            db.backup(rusqlite::DatabaseName::Main, &backup, None)
                .map_err(|_| "Could not back up database before upgrade")?;
        }
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id,id DESC);
            CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS takes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY, body TEXT NOT NULL);
            PRAGMA user_version=2; COMMIT;").map_err(|e|e.to_string())?;
        // Interrupted jobs remain inspectable and do not automatically incur another charge.
        let store = Self { db };
        for mut take in store.all_takes()? {
            if take.status == "rendering" {
                take.status = "interrupted".into();
                for job in &mut take.plan {
                    if job.status == "requesting" {
                        job.status = "unknown".into();
                    }
                }
                take.error =
                    Some("App closed during render. Completed chunks are preserved.".into());
                store.put_take(&take)?;
            }
        }
        Ok(store)
    }
    pub fn save(&mut self, p: &Project, reason: &str) -> Result<(), String> {
        validate_project(p)?;
        let body = serde_json::to_string(p).map_err(|e| e.to_string())?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let old: Option<String> = tx
            .query_row("SELECT body FROM projects WHERE id=?1", [&p.id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if old.as_deref() == Some(&body) {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute("INSERT INTO projects VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",params![p.id,body,now]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT INTO revisions(project_id,body,created_at,reason) VALUES(?1,?2,?3,?4)",
            params![p.id, body, now, reason],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    fn bodies<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<T>, String> {
        let mut stmt = self.db.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(args, |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn projects(&self) -> Result<Vec<Project>, String> {
        self.bodies("SELECT body FROM projects ORDER BY updated_at DESC", &[])
    }
    pub fn voices(&self) -> Result<Vec<Voice>, String> {
        self.bodies(
            "SELECT body FROM voices ORDER BY json_extract(body,'$.name')",
            &[],
        )
    }
    pub fn put_voice(&self, v: &Voice) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO voices VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                params![v.id, serde_json::to_string(v).map_err(|e| e.to_string())?],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn takes(&self, id: &str) -> Result<Vec<Take>, String> {
        self.bodies(
            "SELECT body FROM takes WHERE project_id=?1 ORDER BY rowid DESC",
            &[&id],
        )
    }
    pub fn all_takes(&self) -> Result<Vec<Take>, String> {
        self.bodies("SELECT body FROM takes", &[])
    }
    pub fn take(&self, id: &str) -> Result<Take, String> {
        self.bodies("SELECT body FROM takes WHERE id=?1", &[&id])?
            .into_iter()
            .next()
            .ok_or("Saved take is unavailable".into())
    }
    pub fn get_state(&self, key: &str) -> Result<serde_json::Value, String> {
        let body: Option<String> = self
            .db
            .query_row("SELECT body FROM app_state WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        body.map(|b| serde_json::from_str(&b).map_err(|e| e.to_string()))
            .unwrap_or(Ok(serde_json::Value::Null))
    }
    pub fn set_state(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        self.db.execute("INSERT INTO app_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET body=excluded.body", params![key, value.to_string()]).map(|_| ()).map_err(|e| e.to_string())
    }
    pub fn replace_voices(&self, voices: &[Voice]) -> Result<(), String> {
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM voices", [])
            .map_err(|e| e.to_string())?;
        for voice in voices {
            self.put_voice(voice)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn put_take(&self, t: &Take) -> Result<(), String> {
        self.db.execute("INSERT INTO takes VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![t.id,t.project_id,serde_json::to_string(t).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn revisions(&self, id: &str) -> Result<Vec<Revision>, String> {
        let mut stmt=self.db.prepare("SELECT id,created_at,reason,body FROM revisions WHERE project_id=?1 ORDER BY id DESC LIMIT 200").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            let (id, created_at, reason, body) = r.map_err(|e| e.to_string())?;
            Ok(Revision {
                id,
                created_at,
                reason,
                project: serde_json::from_str(&body).map_err(|e| e.to_string())?,
            })
        })
        .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn p() -> Project {
        Project {
            character_plan: None,
            performance: None,
            id: uuid::Uuid::new_v4().to_string(),
            title: "Original".into(),
            brief: "".into(),
            language: "en".into(),
            model: "gpt-6-astra".into(),
            speakers: vec![Speaker {
                id: "a".into(),
                name: "A".into(),
                personality: "".into(),
                voice_id: "".into(),
            }],
            turns: vec![],
        }
    }
    #[test]
    fn save_deduplicates_restores_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let mut s = Store::open(&path).unwrap();
        let mut p = p();
        s.save(&p, "Created").unwrap();
        s.save(&p, "Autosave").unwrap();
        assert_eq!(s.revisions(&p.id).unwrap().len(), 1);
        let old = p.clone();
        p.title = "Changed".into();
        s.save(&p, "Autosave").unwrap();
        s.save(&old, "Restored").unwrap();
        drop(s);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.projects().unwrap()[0].title, "Original");
        assert_eq!(s.revisions(&p.id).unwrap().len(), 3);
    }
    #[test]
    fn invalid_save_leaves_history_untouched() {
        let mut s = Store::open(Path::new(":memory:")).unwrap();
        let mut p = p();
        s.save(&p, "Created").unwrap();
        p.title.clear();
        assert!(s.save(&p, "Autosave").is_err());
        assert_eq!(s.revisions(&p.id).unwrap().len(), 1);
    }
    #[test]
    fn interrupted_take_preserves_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let mut s = Store::open(&path).unwrap();
        let p = p();
        s.save(&p, "Created").unwrap();
        s.put_take(&Take {
            id: "t".into(),
            project_id: p.id.clone(),
            created_at: "now".into(),
            status: "rendering".into(),
            script: p.clone(),
            chunks: vec![],
            error: None,
            plan: vec![],
            audio_model: audio_model(),
        })
        .unwrap();
        drop(s);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.takes(&p.id).unwrap()[0].status, "interrupted");
    }
    #[test]
    fn migration_backs_up_v1_and_preserves_projects_and_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite3");
        let mut store = Store::open(&path).unwrap();
        let p = p();
        store.save(&p, "Created").unwrap();
        store.db.pragma_update(None, "user_version", 1).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.projects().unwrap()[0], p);
        assert!(std::fs::read_dir(dir.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with("backup.sqlite3")));
        store
            .set_state("voice-draft", &serde_json::json!({"name":"A","samples":[]}))
            .unwrap();
        drop(store);
        assert_eq!(
            Store::open(&path)
                .unwrap()
                .get_state("voice-draft")
                .unwrap()["name"],
            "A"
        );
    }
    #[test]
    fn refuses_future_database_version_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.pragma_update(None, "user_version", 99).unwrap();
        drop(db);
        assert!(Store::open(&path).is_err());
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            99
        );
    }
}
