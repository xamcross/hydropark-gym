#![allow(dead_code)] // Phase-1 on-device store core; wired into the app-data layer in a later ticket.

//! On-device SQLite persistence (P1-10.1 / P1-10.4, SPEC §6 / §10).
//!
//! This is the **local, offline** store — the app-data database on the user's
//! machine. It is deliberately unrelated to the cloud MongoDB Atlas store the
//! backend owns (catalog, licences at issuance, telemetry). Nothing here talks to
//! the network; it only reads/writes the user's own device state so the app works
//! fully offline (SPEC §6).
//!
//! ## What it holds
//!  - **agents** — opaque agent documents (base-model + composed-skill state),
//!    stored as a JSON text blob keyed by agent id.
//!  - **templates** — saved, named skill combinations (`templates::Template`,
//!    SPEC §10), stored as a JSON text blob keyed by the template id.
//!  - **licenses** — cached compact-JWS licence tokens (SPEC §13.3), keyed by
//!    `(skill_id, kid)`. Storing the token verbatim keeps this layer ignorant of
//!    the JWS format (verification lives in `license_verify`); the store only
//!    remembers the newest token per skill so a returning user is entitled offline.
//!  - **panel_state** — opaque per-agent UI panel layout/state (SPEC §9), a JSON
//!    blob keyed by agent id.
//!  - **chats** — append-only chat transcript rows, keyed by a `chat_id`.
//!
//! ## Migrations (P1-10.4)
//! A **forward-only** runner driven by `PRAGMA user_version`. Each entry in
//! [`MIGRATIONS`] migrates `user_version i -> i+1`; the current target is the
//! array length. The runner:
//!   - is **idempotent**: once `user_version == target`, re-running does nothing;
//!   - **never downgrades**: a DB written by a newer build (version above target)
//!     is left untouched, so an older binary can't clobber newer offline data;
//!   - **never breaks existing data**: steps only *append* schema; the v0→v1 step
//!     uses `CREATE TABLE IF NOT EXISTS`, and future versions are added by pushing
//!     a new step onto [`MIGRATIONS`] — existing steps are never edited or reordered.
//!
//! ## Self-contained by design
//! Only depends on `rusqlite` (bundled SQLite) + `serde_json` + the crate's
//! `templates` types, so it compiles and unit-tests under the toolchain-free
//! `mock-inference` build. The tests below run entirely against an in-memory
//! `:memory:` database — no real files, no network.
//!
//! ── Registration (hand-off for the lead) ───────────────────────────────────
//! `mod store;` is already declared in `main.rs`. Wiring the store into a Tauri
//! `.manage()`-d state (resolving the app-data dir from the `AppHandle`, same as
//! `unlock.rs`) and exposing IPC commands is a separate ticket; this module is the
//! pure persistence core those commands will drive.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::templates::Template;

// ===========================================================================
// Errors
// ===========================================================================

/// Anything that can go wrong talking to the on-device store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// An error from SQLite (open, migrate, or a statement).
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A body blob failed to (de)serialize to/from JSON.
    #[error("json (de)serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

// ===========================================================================
// Migrations — forward-only, driven by PRAGMA user_version (P1-10.4)
// ===========================================================================

/// The ordered, forward-only migration steps. Step at index `i` migrates a
/// database from `user_version == i` to `i + 1`.
///
/// **Append only.** To evolve the schema, push a new `migrate_vN_to_vN1` fn onto
/// the end — never edit, remove, or reorder an existing step, or an already-migrated
/// user's database would diverge from a fresh one (P1-10.4).
const MIGRATIONS: &[fn(&Connection) -> Result<(), StoreError>] = &[migrate_v0_to_v1];

/// The schema version this build targets — the number of migration steps.
const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// v0 → v1: create every table. Idempotent on its own (`IF NOT EXISTS`) so a
/// half-applied migration can be safely re-run without destroying data.
fn migrate_v0_to_v1(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agents (
            id          TEXT PRIMARY KEY,
            body        TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
            id          TEXT PRIMARY KEY,
            body        TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS licenses (
            skill_id    TEXT NOT NULL,
            kid         TEXT NOT NULL,
            compact_jws TEXT NOT NULL,
            cached_at   INTEGER NOT NULL,
            PRIMARY KEY (skill_id, kid)
        );
        CREATE TABLE IF NOT EXISTS panel_state (
            agent_id    TEXT PRIMARY KEY,
            body        TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chats (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id     TEXT NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chats_chat ON chats (chat_id, id);",
    )?;
    Ok(())
}

/// Run every pending migration in order. Forward-only and idempotent; leaves a
/// newer-than-known database untouched (never downgrades).
fn run_migrations(conn: &Connection) -> Result<(), StoreError> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    // A database written by a newer build must not be rolled back (P1-10.4).
    if version > SCHEMA_VERSION {
        return Ok(());
    }

    while version < SCHEMA_VERSION {
        MIGRATIONS[version as usize](conn)?;
        version += 1;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

// ===========================================================================
// Returned row types
// ===========================================================================

/// A cached compact-JWS licence token as stored on-device (SPEC §13.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedLicense {
    pub skill_id: String,
    /// The signing-key id the token was issued under.
    pub kid: String,
    /// The compact-JWS token, stored verbatim (this layer does not parse it).
    pub compact_jws: String,
    /// When it was cached (epoch milliseconds) — used to pick the newest.
    pub cached_at: i64,
}

/// One row of a chat transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Monotonic row id (assigned on append; also the append order).
    pub id: i64,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    /// When the message was recorded (epoch milliseconds).
    pub created_at: i64,
}

// ===========================================================================
// Store
// ===========================================================================

/// The on-device store: a thin, migrated wrapper over a `rusqlite` connection.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating if absent) the on-device database at `path` and bring its
    /// schema up to date.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::from_connection(Connection::open(path)?)
    }

    /// Open a fresh in-memory database — used by tests and ephemeral tooling.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self, StoreError> {
        run_migrations(&conn)?;
        Ok(Self { conn })
    }

    /// The database's current `PRAGMA user_version`.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let v: i64 = self.conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        Ok(v)
    }

    // ---- templates -------------------------------------------------------

    /// Insert or replace a template, keyed by its id (SPEC §10 "My Templates").
    pub fn save_template(&self, template: &Template) -> Result<(), StoreError> {
        let body = serde_json::to_string(template)?;
        self.conn.execute(
            "INSERT INTO templates (id, body, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![template.id, body, now_ms()],
        )?;
        Ok(())
    }

    /// Load a template by id, or `None` if there is no such template.
    pub fn load_template(&self, id: &str) -> Result<Option<Template>, StoreError> {
        let body: Option<String> = self
            .conn
            .query_row("SELECT body FROM templates WHERE id = ?1", params![id], |row| row.get(0))
            .optional()?;
        match body {
            Some(b) => Ok(Some(serde_json::from_str(&b)?)),
            None => Ok(None),
        }
    }

    // ---- agents (opaque JSON documents) ----------------------------------

    /// Insert or replace an agent document, keyed by agent id.
    pub fn save_agent(&self, id: &str, body: &serde_json::Value) -> Result<(), StoreError> {
        let json = serde_json::to_string(body)?;
        self.conn.execute(
            "INSERT INTO agents (id, body, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![id, json, now_ms()],
        )?;
        Ok(())
    }

    /// Load an agent document by id, or `None`.
    pub fn load_agent(&self, id: &str) -> Result<Option<serde_json::Value>, StoreError> {
        let body: Option<String> = self
            .conn
            .query_row("SELECT body FROM agents WHERE id = ?1", params![id], |row| row.get(0))
            .optional()?;
        match body {
            Some(b) => Ok(Some(serde_json::from_str(&b)?)),
            None => Ok(None),
        }
    }

    // ---- licenses (cached compact-JWS, keyed by skill + kid) --------------

    /// Cache a compact-JWS licence token for `(skill_id, kid)`. Re-caching the
    /// same pair upserts (replaces token + timestamp) rather than duplicating.
    /// `cached_at` is caller-supplied (epoch ms) so callers control recency.
    pub fn cache_license(
        &self,
        skill_id: &str,
        kid: &str,
        compact_jws: &str,
        cached_at: i64,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO licenses (skill_id, kid, compact_jws, cached_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(skill_id, kid) DO UPDATE SET
                 compact_jws = excluded.compact_jws,
                 cached_at   = excluded.cached_at",
            params![skill_id, kid, compact_jws, cached_at],
        )?;
        Ok(())
    }

    /// Fetch the newest cached licence for a skill (highest `cached_at` across all
    /// cached kids), or `None` if nothing is cached for it.
    pub fn newest_license(&self, skill_id: &str) -> Result<Option<CachedLicense>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT skill_id, kid, compact_jws, cached_at FROM licenses
                 WHERE skill_id = ?1 ORDER BY cached_at DESC, kid DESC LIMIT 1",
                params![skill_id],
                |row| {
                    Ok(CachedLicense {
                        skill_id: row.get(0)?,
                        kid: row.get(1)?,
                        compact_jws: row.get(2)?,
                        cached_at: row.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    // ---- panel state (opaque per-agent UI layout) ------------------------

    /// Insert or replace the UI panel state for an agent.
    pub fn save_panel_state(
        &self,
        agent_id: &str,
        state: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let json = serde_json::to_string(state)?;
        self.conn.execute(
            "INSERT INTO panel_state (agent_id, body, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(agent_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![agent_id, json, now_ms()],
        )?;
        Ok(())
    }

    /// Load an agent's UI panel state, or `None`.
    pub fn load_panel_state(
        &self,
        agent_id: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        let body: Option<String> = self
            .conn
            .query_row("SELECT body FROM panel_state WHERE agent_id = ?1", params![agent_id], |row| {
                row.get(0)
            })
            .optional()?;
        match body {
            Some(b) => Ok(Some(serde_json::from_str(&b)?)),
            None => Ok(None),
        }
    }

    // ---- chats (append-only transcript) ----------------------------------

    /// Append one message to a chat transcript; returns its assigned row id.
    pub fn append_chat_message(
        &self,
        chat_id: &str,
        role: &str,
        content: &str,
        created_at: i64,
    ) -> Result<i64, StoreError> {
        self.conn.execute(
            "INSERT INTO chats (chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![chat_id, role, content, created_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// List a chat's messages in append order (by row id).
    pub fn list_chat_messages(&self, chat_id: &str) -> Result<Vec<ChatMessage>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, chat_id, role, content, created_at FROM chats
             WHERE chat_id = ?1 ORDER BY id ASC",
        )?;
        let msgs = stmt
            .query_map(params![chat_id], |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(msgs)
    }
}

/// Current wall-clock time in epoch milliseconds (metadata for `updated_at`).
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ===========================================================================
// Tests (in-memory :memory: db — no real files, no network)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates::{save_as_template, SemVer};
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory().expect("in-memory store opens + migrates")
    }

    fn sample_template(name: &str) -> Template {
        save_as_template(
            name,
            "qwen2.5-3b-instruct-q4_k_m",
            &[("cooking-assistant", SemVer::new(1, 2, 0))],
            json!({ "panel_order": ["timers", "ingredients"] }),
        )
    }

    // ---- migrations: idempotent, forward-only, non-destructive (P1-10.4) -----

    #[test]
    fn migrations_run_once_and_are_a_no_op_the_second_time() {
        let s = store();
        // A fresh open leaves the DB at the target version.
        assert_eq!(SCHEMA_VERSION, 1);
        assert_eq!(s.schema_version().unwrap(), 1);

        // Seed data, then re-run the runner: it must not touch the version...
        let tpl = sample_template("Weeknight Chef");
        s.save_template(&tpl).unwrap();

        run_migrations(&s.conn).unwrap();
        assert_eq!(s.schema_version().unwrap(), 1, "no re-bump / no downgrade");

        // ...and must not destroy existing offline data.
        assert_eq!(
            s.load_template(&tpl.id).unwrap(),
            Some(tpl),
            "existing rows survive a second migration pass"
        );
    }

    #[test]
    fn migrations_never_downgrade_a_newer_database() {
        let s = store();
        // Simulate a DB written by a future build (version above what we know).
        s.conn.pragma_update(None, "user_version", 99_i64).unwrap();
        run_migrations(&s.conn).unwrap();
        assert_eq!(s.schema_version().unwrap(), 99, "a newer DB is left untouched");
    }

    // ---- templates: round-trip + upsert --------------------------------------

    #[test]
    fn template_round_trips() {
        let s = store();
        let tpl = sample_template("Weeknight Chef");
        assert_eq!(s.load_template(&tpl.id).unwrap(), None, "absent before save");

        s.save_template(&tpl).unwrap();
        assert_eq!(s.load_template(&tpl.id).unwrap(), Some(tpl.clone()));

        // Saving again under the same id replaces the stored body (upsert).
        let mut updated = tpl.clone();
        updated.base_model = "some-other-model".to_string();
        s.save_template(&updated).unwrap();
        assert_eq!(s.load_template(&tpl.id).unwrap(), Some(updated));
    }

    // ---- licenses: cache then fetch the newest -------------------------------

    #[test]
    fn license_cache_stores_then_fetches_the_newest() {
        let s = store();
        assert_eq!(s.newest_license("cooking-assistant").unwrap(), None);

        // Two kids for the same skill; the later cached_at wins.
        s.cache_license("cooking-assistant", "kid-old", "jws.old", 1_000).unwrap();
        s.cache_license("cooking-assistant", "kid-new", "jws.new", 2_000).unwrap();
        // A different skill must not leak into the result.
        s.cache_license("nutrition-coach", "kid-z", "jws.other", 9_999).unwrap();

        let newest = s.newest_license("cooking-assistant").unwrap().unwrap();
        assert_eq!(
            newest,
            CachedLicense {
                skill_id: "cooking-assistant".to_string(),
                kid: "kid-new".to_string(),
                compact_jws: "jws.new".to_string(),
                cached_at: 2_000,
            }
        );

        // Re-caching the same (skill, kid) upserts rather than duplicating, and
        // becomes the newest.
        s.cache_license("cooking-assistant", "kid-new", "jws.newer", 3_000).unwrap();
        let newest = s.newest_license("cooking-assistant").unwrap().unwrap();
        assert_eq!(newest.compact_jws, "jws.newer");
        assert_eq!(newest.cached_at, 3_000);
    }

    // ---- panel state: round-trip, per-agent ----------------------------------

    #[test]
    fn panel_state_round_trips_per_agent() {
        let s = store();
        assert_eq!(s.load_panel_state("agent-1").unwrap(), None);

        let state = json!({
            "order": ["timers", "ingredients"],
            "panels": [{ "id": "timers", "collapsed": false }]
        });
        s.save_panel_state("agent-1", &state).unwrap();
        assert_eq!(s.load_panel_state("agent-1").unwrap(), Some(state.clone()));

        // State is isolated per agent.
        assert_eq!(s.load_panel_state("agent-2").unwrap(), None);

        // Saving again replaces (upsert).
        let state2 = json!({ "order": [], "panels": [] });
        s.save_panel_state("agent-1", &state2).unwrap();
        assert_eq!(s.load_panel_state("agent-1").unwrap(), Some(state2));
    }

    // ---- agents: opaque JSON round-trip --------------------------------------

    #[test]
    fn agent_body_round_trips() {
        let s = store();
        assert_eq!(s.load_agent("agent-1").unwrap(), None);

        let body = json!({ "base_model": "m", "skills": ["cooking-assistant"] });
        s.save_agent("agent-1", &body).unwrap();
        assert_eq!(s.load_agent("agent-1").unwrap(), Some(body));
    }

    // ---- chats: append + list in order, isolated per chat --------------------

    #[test]
    fn chat_messages_append_and_list_in_order() {
        let s = store();
        assert!(s.list_chat_messages("chat-1").unwrap().is_empty());

        let id1 = s.append_chat_message("chat-1", "user", "hello", 10).unwrap();
        let id2 = s.append_chat_message("chat-1", "assistant", "hi there", 20).unwrap();
        // A message in another chat must not appear in chat-1's list.
        s.append_chat_message("chat-2", "user", "elsewhere", 15).unwrap();

        assert!(id2 > id1, "row ids are monotonic in append order");

        let msgs = s.list_chat_messages("chat-1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, id1);
        assert_eq!((msgs[0].role.as_str(), msgs[0].content.as_str()), ("user", "hello"));
        assert_eq!(msgs[0].created_at, 10);
        assert_eq!((msgs[1].role.as_str(), msgs[1].content.as_str()), ("assistant", "hi there"));
    }
}
