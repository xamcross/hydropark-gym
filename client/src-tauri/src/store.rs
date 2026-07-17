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
const MIGRATIONS: &[fn(&Connection) -> Result<(), StoreError>] =
    &[migrate_v0_to_v1, migrate_v1_to_v2, migrate_v2_to_v3];

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

/// v1 → v2: the account/licensing layer (P1-09.x). Three tables, all appended
/// (never editing v1's step): the single-row `auth_session` (the persisted
/// access+refresh token pair), the single-row `device_identity` (the stable
/// install id + coarse fingerprint + Ed25519 device keypair), and the cached
/// `entitlements` set. The two singletons pin their row with a `CHECK (id = 0)`
/// so the upsert is a plain `ON CONFLICT(id)`.
fn migrate_v1_to_v2(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS auth_session (
            id            INTEGER PRIMARY KEY CHECK (id = 0),
            access_token  TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            email         TEXT,
            access_exp_ms INTEGER,
            updated_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_identity (
            id               INTEGER PRIMARY KEY CHECK (id = 0),
            install_id       TEXT NOT NULL,
            signing_key      BLOB NOT NULL,
            fingerprint      TEXT,
            server_device_id TEXT,
            registered       INTEGER NOT NULL DEFAULT 0,
            updated_at       INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entitlements (
            skill_id   TEXT PRIMARY KEY,
            status     TEXT NOT NULL,
            cached_at  INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

/// v2 → v3: the installed-skill registry (P1-03.2). One appended table (never
/// editing v1/v2's steps) recording each `.hpskill` package that passed the full
/// install gate (signature verify → manifest re-validate → compatibility). It is
/// the on-disk source of truth the `SkillManager` rehydrates from at launch: the
/// verified raw `manifest` JSON, the extraction `dir`, the resolved `version`, and
/// the last enable/disable state, keyed by the skill id.
fn migrate_v2_to_v3(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS installed_skills (
            skill_id     TEXT PRIMARY KEY,
            version      TEXT NOT NULL,
            manifest     TEXT NOT NULL,
            dir          TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 0,
            installed_at INTEGER NOT NULL
        );",
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

/// The persisted account session (P1-09.x): the access + refresh token pair the
/// backend `/v1/auth` minted, plus the account email (when it has one) and the
/// access token's decoded expiry (epoch ms) used to drive proactive refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSession {
    pub access_token: String,
    pub refresh_token: String,
    pub email: Option<String>,
    /// The access token's `exp` claim as epoch milliseconds, if it was decodable.
    pub access_exp_ms: Option<i64>,
}

/// The persisted per-install device identity (P1-09.3 / .8): a stable install id,
/// the Ed25519 device secret-key seed (32 bytes), the coarse fingerprint sent to
/// `/v1/devices/register`, and whether the backend has accepted a registration
/// (with the server-assigned device id when it has).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDeviceIdentity {
    pub install_id: String,
    /// 32-byte Ed25519 seed; `device.rs` reconstitutes the `SigningKey` from it.
    pub signing_key: Vec<u8>,
    pub fingerprint: Option<String>,
    pub server_device_id: Option<String>,
    pub registered: bool,
}

/// One cached entitlement row (P1-09.7) — the local mirror of `GET /v1/entitlements`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedEntitlement {
    pub skill_id: String,
    pub status: String,
    /// When the entitlement set was last cached (epoch milliseconds).
    pub cached_at: i64,
}

/// One installed `.hpskill` package on disk (P1-03.2). The `manifest` is the
/// verified raw manifest JSON exactly as it passed signature verification; `dir`
/// is where its `manifest.json` + sanitized assets/strings were extracted.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledSkill {
    pub skill_id: String,
    pub version: String,
    pub manifest: serde_json::Value,
    pub dir: String,
    pub enabled: bool,
    /// When the package was installed (epoch milliseconds).
    pub installed_at: i64,
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

    /// All saved templates — the "My Templates" gallery (SPEC §10), newest-saved
    /// first (`updated_at DESC`; ties break on id for a deterministic order).
    pub fn list_templates(&self) -> Result<Vec<Template>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM templates ORDER BY updated_at DESC, id ASC")?;
        let bodies = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        bodies.iter().map(|b| Ok(serde_json::from_str(b)?)).collect()
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

    // ---- account session (single row, P1-09.x) ---------------------------

    /// Persist (upsert) the account's access + refresh token pair. `email` is the
    /// account email when known; `access_exp_ms` is the access token's decoded
    /// `exp` (epoch ms) or `None` when it could not be read.
    pub fn save_session(
        &self,
        access_token: &str,
        refresh_token: &str,
        email: Option<&str>,
        access_exp_ms: Option<i64>,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO auth_session (id, access_token, refresh_token, email, access_exp_ms, updated_at)
             VALUES (0, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 access_token  = excluded.access_token,
                 refresh_token = excluded.refresh_token,
                 email         = excluded.email,
                 access_exp_ms = excluded.access_exp_ms,
                 updated_at    = excluded.updated_at",
            params![access_token, refresh_token, email, access_exp_ms, now_ms()],
        )?;
        Ok(())
    }

    /// The persisted session, or `None` if the user is signed out.
    pub fn load_session(&self) -> Result<Option<StoredSession>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT access_token, refresh_token, email, access_exp_ms
                 FROM auth_session WHERE id = 0",
                [],
                |row| {
                    Ok(StoredSession {
                        access_token: row.get(0)?,
                        refresh_token: row.get(1)?,
                        email: row.get(2)?,
                        access_exp_ms: row.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Clear the persisted session (the local half of sign-out).
    pub fn clear_session(&self) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM auth_session", [])?;
        Ok(())
    }

    // ---- device identity (single row, P1-09.3/.8) ------------------------

    /// Persist (upsert) the device identity: stable install id, Ed25519 seed,
    /// coarse fingerprint, and registration state.
    pub fn save_device_identity(
        &self,
        install_id: &str,
        signing_key: &[u8],
        fingerprint: Option<&str>,
        server_device_id: Option<&str>,
        registered: bool,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO device_identity
                 (id, install_id, signing_key, fingerprint, server_device_id, registered, updated_at)
             VALUES (0, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 install_id       = excluded.install_id,
                 signing_key      = excluded.signing_key,
                 fingerprint      = excluded.fingerprint,
                 server_device_id = excluded.server_device_id,
                 registered       = excluded.registered,
                 updated_at       = excluded.updated_at",
            params![install_id, signing_key, fingerprint, server_device_id, registered, now_ms()],
        )?;
        Ok(())
    }

    /// The persisted device identity, or `None` before first run.
    pub fn load_device_identity(&self) -> Result<Option<StoredDeviceIdentity>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT install_id, signing_key, fingerprint, server_device_id, registered
                 FROM device_identity WHERE id = 0",
                [],
                |row| {
                    Ok(StoredDeviceIdentity {
                        install_id: row.get(0)?,
                        signing_key: row.get(1)?,
                        fingerprint: row.get(2)?,
                        server_device_id: row.get(3)?,
                        registered: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    // ---- entitlements cache (P1-09.7) ------------------------------------

    /// Replace the cached entitlement set wholesale with `items` (`(skill_id,
    /// status)` pairs) stamped `cached_at`. Wholesale replace (in one transaction)
    /// so a skill that dropped off the server's list does not linger locally.
    pub fn cache_entitlements(
        &self,
        items: &[(String, String)],
        cached_at: i64,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM entitlements", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO entitlements (skill_id, status, cached_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(skill_id) DO UPDATE SET
                     status = excluded.status, cached_at = excluded.cached_at",
            )?;
            for (skill_id, status) in items {
                stmt.execute(params![skill_id, status, cached_at])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The cached entitlement set, ordered by skill id.
    pub fn load_entitlements(&self) -> Result<Vec<CachedEntitlement>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT skill_id, status, cached_at FROM entitlements ORDER BY skill_id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CachedEntitlement {
                    skill_id: row.get(0)?,
                    status: row.get(1)?,
                    cached_at: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ---- installed skills (.hpskill registry, P1-03.2) -------------------

    /// Record (upsert) an installed skill package, keyed by skill id. `manifest`
    /// is the verified raw manifest JSON; `dir` is its extraction directory.
    /// Re-installing the same id replaces the row (a reinstall is free, §11.3).
    pub fn save_installed_skill(
        &self,
        skill_id: &str,
        version: &str,
        manifest: &serde_json::Value,
        dir: &str,
        enabled: bool,
    ) -> Result<(), StoreError> {
        let manifest_json = serde_json::to_string(manifest)?;
        self.conn.execute(
            "INSERT INTO installed_skills (skill_id, version, manifest, dir, enabled, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(skill_id) DO UPDATE SET
                 version      = excluded.version,
                 manifest     = excluded.manifest,
                 dir          = excluded.dir,
                 enabled      = excluded.enabled,
                 installed_at = excluded.installed_at",
            params![skill_id, version, manifest_json, dir, enabled, now_ms()],
        )?;
        Ok(())
    }

    /// Load one installed skill by id, or `None` if it is not installed.
    pub fn load_installed_skill(
        &self,
        skill_id: &str,
    ) -> Result<Option<InstalledSkill>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT skill_id, version, manifest, dir, enabled, installed_at
                 FROM installed_skills WHERE skill_id = ?1",
                params![skill_id],
                installed_skill_from_row,
            )
            .optional()?;
        row.transpose()
    }

    /// All installed skills, ordered by skill id (deterministic rehydration order).
    pub fn list_installed_skills(&self) -> Result<Vec<InstalledSkill>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT skill_id, version, manifest, dir, enabled, installed_at
             FROM installed_skills ORDER BY skill_id ASC",
        )?;
        let rows = stmt
            .query_map([], installed_skill_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Each row parsed its manifest lazily (Result inside); surface any JSON error.
        rows.into_iter().collect()
    }

    /// Flip the persisted enable/disable flag for an installed skill (no-op if the
    /// skill id is not installed).
    pub fn set_installed_skill_enabled(
        &self,
        skill_id: &str,
        enabled: bool,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE installed_skills SET enabled = ?2 WHERE skill_id = ?1",
            params![skill_id, enabled],
        )?;
        Ok(())
    }

    /// Remove an installed skill's row (the store half of uninstall). Idempotent.
    pub fn remove_installed_skill(&self, skill_id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM installed_skills WHERE skill_id = ?1", params![skill_id])?;
        Ok(())
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

/// Map an `installed_skills` row into an [`InstalledSkill`]. The `manifest` column
/// is JSON text, so parsing can fail: the outer `rusqlite::Result` covers the
/// column reads and the inner `Result<_, StoreError>` covers the JSON decode, which
/// the callers flatten (`transpose` / `collect`) into a single `StoreError`.
fn installed_skill_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<InstalledSkill, StoreError>> {
    let skill_id: String = row.get(0)?;
    let version: String = row.get(1)?;
    let manifest_json: String = row.get(2)?;
    let dir: String = row.get(3)?;
    let enabled: bool = row.get(4)?;
    let installed_at: i64 = row.get(5)?;
    Ok(serde_json::from_str(&manifest_json)
        .map(|manifest| InstalledSkill { skill_id, version, manifest, dir, enabled, installed_at })
        .map_err(StoreError::from))
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
        assert_eq!(SCHEMA_VERSION, 3);
        assert_eq!(s.schema_version().unwrap(), 3);

        // Seed data, then re-run the runner: it must not touch the version...
        let tpl = sample_template("Weeknight Chef");
        s.save_template(&tpl).unwrap();

        run_migrations(&s.conn).unwrap();
        assert_eq!(s.schema_version().unwrap(), 3, "no re-bump / no downgrade");

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

    // ---- templates: list ordered by updated_at desc (Task 11a) --------------

    #[test]
    fn list_templates_orders_by_updated_at_desc() {
        let s = store();
        assert!(s.list_templates().unwrap().is_empty(), "empty before any save");

        let a = sample_template("A");
        let b = sample_template("B");
        let c = sample_template("C");
        s.save_template(&a).unwrap();
        s.save_template(&b).unwrap();
        s.save_template(&c).unwrap();

        // Force a deterministic updated_at ordering directly (bypassing wall-clock
        // timing, which is too coarse at millisecond resolution to trust in a test).
        s.conn.execute("UPDATE templates SET updated_at = 1000 WHERE id = ?1", params![a.id]).unwrap();
        s.conn.execute("UPDATE templates SET updated_at = 3000 WHERE id = ?1", params![b.id]).unwrap();
        s.conn.execute("UPDATE templates SET updated_at = 2000 WHERE id = ?1", params![c.id]).unwrap();

        let listed = s.list_templates().unwrap();
        let ids: Vec<&str> = listed.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec![b.id.as_str(), c.id.as_str(), a.id.as_str()], "newest updated_at first");
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

    // ---- account session: round-trip + clear (P1-09.x) -----------------------

    #[test]
    fn session_round_trips_then_clears() {
        let s = store();
        assert_eq!(s.load_session().unwrap(), None, "signed out before any save");

        s.save_session("acc-1", "ref-1", Some("chef@example.com"), Some(1_770_000_000_000))
            .unwrap();
        assert_eq!(
            s.load_session().unwrap(),
            Some(StoredSession {
                access_token: "acc-1".into(),
                refresh_token: "ref-1".into(),
                email: Some("chef@example.com".into()),
                access_exp_ms: Some(1_770_000_000_000),
            })
        );

        // Re-saving upserts the single row (rotated tokens, unknown expiry).
        s.save_session("acc-2", "ref-2", None, None).unwrap();
        let loaded = s.load_session().unwrap().unwrap();
        assert_eq!(loaded.access_token, "acc-2");
        assert_eq!(loaded.email, None);
        assert_eq!(loaded.access_exp_ms, None);

        s.clear_session().unwrap();
        assert_eq!(s.load_session().unwrap(), None, "cleared on sign-out");
    }

    // ---- device identity: round-trip, single row -----------------------------

    #[test]
    fn device_identity_round_trips_and_upserts() {
        let s = store();
        assert_eq!(s.load_device_identity().unwrap(), None);

        let seed = vec![9u8; 32];
        s.save_device_identity("inst-1", &seed, Some("fp1-abc"), None, false).unwrap();
        assert_eq!(
            s.load_device_identity().unwrap(),
            Some(StoredDeviceIdentity {
                install_id: "inst-1".into(),
                signing_key: seed.clone(),
                fingerprint: Some("fp1-abc".into()),
                server_device_id: None,
                registered: false,
            })
        );

        // Marking it registered preserves install id + key, flips the flag.
        s.save_device_identity("inst-1", &seed, Some("fp1-abc"), Some("srv-dev-7"), true)
            .unwrap();
        let d = s.load_device_identity().unwrap().unwrap();
        assert_eq!(d.install_id, "inst-1");
        assert!(d.registered);
        assert_eq!(d.server_device_id.as_deref(), Some("srv-dev-7"));
    }

    // ---- entitlements cache: wholesale replace -------------------------------

    #[test]
    fn entitlements_cache_replaces_wholesale() {
        let s = store();
        assert!(s.load_entitlements().unwrap().is_empty());

        s.cache_entitlements(
            &[
                ("cooking-assistant".into(), "owned".into()),
                ("garden-plants".into(), "owned".into()),
            ],
            1_000,
        )
        .unwrap();
        let rows = s.load_entitlements().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].skill_id, "cooking-assistant"); // ordered by skill id

        // A later refresh replaces the set — a dropped skill does not linger.
        s.cache_entitlements(&[("cooking-assistant".into(), "revoked".into())], 2_000)
            .unwrap();
        let rows = s.load_entitlements().unwrap();
        assert_eq!(rows.len(), 1, "wholesale replace drops garden-plants");
        assert_eq!(rows[0].status, "revoked");
        assert_eq!(rows[0].cached_at, 2_000);
    }

    // ---- installed skills: round-trip, enable flip, remove (P1-03.2) ---------

    #[test]
    fn installed_skill_round_trips_upserts_and_removes() {
        let s = store();
        assert_eq!(s.load_installed_skill("cooking-assistant").unwrap(), None);
        assert!(s.list_installed_skills().unwrap().is_empty());

        let manifest = json!({ "id": "cooking-assistant", "version": "1.2.0", "pricing": { "free": false } });
        s.save_installed_skill("cooking-assistant", "1.2.0", &manifest, "/skills/cooking-assistant", false)
            .unwrap();

        let loaded = s.load_installed_skill("cooking-assistant").unwrap().unwrap();
        assert_eq!(loaded.skill_id, "cooking-assistant");
        assert_eq!(loaded.version, "1.2.0");
        assert_eq!(loaded.manifest, manifest);
        assert_eq!(loaded.dir, "/skills/cooking-assistant");
        assert!(!loaded.enabled);

        // Enable flip persists.
        s.set_installed_skill_enabled("cooking-assistant", true).unwrap();
        assert!(s.load_installed_skill("cooking-assistant").unwrap().unwrap().enabled);

        // Re-installing the same id upserts (a new version replaces the row).
        let v2 = json!({ "id": "cooking-assistant", "version": "1.3.0" });
        s.save_installed_skill("cooking-assistant", "1.3.0", &v2, "/skills/cooking-assistant", false)
            .unwrap();
        let reloaded = s.load_installed_skill("cooking-assistant").unwrap().unwrap();
        assert_eq!(reloaded.version, "1.3.0");
        assert!(!reloaded.enabled, "upsert reset the enable flag to the new install's value");
        assert_eq!(s.list_installed_skills().unwrap().len(), 1, "upsert, not a duplicate");

        // Remove is the store half of uninstall.
        s.remove_installed_skill("cooking-assistant").unwrap();
        assert_eq!(s.load_installed_skill("cooking-assistant").unwrap(), None);
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
