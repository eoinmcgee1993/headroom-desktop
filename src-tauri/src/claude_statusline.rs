//! Per-conversation input savings for the Claude Code statusline.
//!
//! The intercept pairs each Claude Code request's `x-claude-code-session-id`
//! with the backend's `x-headroom-tokens-saved` response header (on streaming
//! responses it comes from the stream-metering vendor in the sitecustomize)
//! and records it here. The statusline script `client_adapters` installs looks
//! its conversation up in this file by the `session_id` Claude Code passes it
//! on stdin. Token counts only, never content.
//!
//! Summing a conversation's `tokens_saved` counts each removed token once:
//! Anthropic's cached prefix is frozen, so a turn's figure covers only content
//! new to the conversation (see the wheel's conversation_savings.py).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// Conversations kept; the least recently updated is dropped first. Far above
/// the number of Claude Code sessions anyone keeps open at once.
const MAX_SESSIONS: usize = 64;
const SCHEMA_VERSION: u32 = 1;
const FILE_NAME: &str = "claude-statusline.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Session {
    tokens_saved: u64,
    last_request_saved: u64,
    updated_at_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Persisted {
    schema_version: u32,
    sessions: BTreeMap<String, Session>,
}

static SESSIONS: Mutex<Option<BTreeMap<String, Session>>> = Mutex::new(None);
/// Held across serialize + write so a snapshot taken later is always written
/// later: two in-flight writes can never leave the older one on disk.
static WRITE: Mutex<()> = Mutex::new(());

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn state_path() -> PathBuf {
    crate::storage::config_file(&crate::storage::app_data_dir(), FILE_NAME)
}

fn load(path: &Path) -> BTreeMap<String, Session> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_slice::<Persisted>(&bytes) {
        Ok(persisted) if persisted.schema_version == SCHEMA_VERSION => persisted.sessions,
        Ok(_) => BTreeMap::new(),
        Err(err) => {
            log::warn!("{FILE_NAME} is corrupt ({err}); backing up and starting fresh");
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            BTreeMap::new()
        }
    }
}

/// A request that saved nothing never opens an entry, so the statusline stays
/// silent until the conversation has a real saving to report.
fn apply(sessions: &mut BTreeMap<String, Session>, session_id: &str, saved: u64, now_ms: i64) {
    if saved == 0 && !sessions.contains_key(session_id) {
        return;
    }
    let session = sessions.entry(session_id.to_string()).or_default();
    session.tokens_saved = session.tokens_saved.saturating_add(saved);
    session.last_request_saved = saved;
    session.updated_at_ms = now_ms;
    while sessions.len() > MAX_SESSIONS {
        let oldest = sessions
            .iter()
            .min_by_key(|(_, s)| s.updated_at_ms)
            .map(|(id, _)| id.clone());
        match oldest {
            Some(id) => sessions.remove(&id),
            None => break,
        };
    }
}

fn persist() {
    let _write = lock(&WRITE);
    let bytes = {
        let guard = lock(&SESSIONS);
        let Some(sessions) = guard.as_ref() else {
            return;
        };
        serde_json::to_vec(&Persisted {
            schema_version: SCHEMA_VERSION,
            sessions: sessions.clone(),
        })
        .unwrap_or_default()
    };
    if let Err(err) = crate::client_adapters::atomic_write(&state_path(), &bytes) {
        log::warn!("failed to persist {FILE_NAME}: {err}");
    }
}

/// Book one Claude Code request's input saving against its conversation.
pub fn record(session_id: &str, tokens_saved: i64) {
    let saved = tokens_saved.max(0) as u64;
    {
        let mut guard = lock(&SESSIONS);
        // Unit tests stay in memory: without HEADROOM_DATA_DIR, state_path()
        // is the real profile's config dir.
        let sessions = guard.get_or_insert_with(|| {
            if cfg!(test) {
                BTreeMap::new()
            } else {
                load(&state_path())
            }
        });
        let before = sessions.get(session_id).cloned();
        apply(
            sessions,
            session_id,
            saved,
            chrono::Utc::now().timestamp_millis(),
        );
        if cfg!(test) || sessions.get(session_id) == before.as_ref() {
            return;
        }
    }
    // atomic_write fsyncs; keep that off the relay task that called us.
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(persist);
        }
        Err(_) => persist(),
    }
}

/// (tokens saved this conversation, saved on its last request).
#[cfg(test)]
pub(crate) fn recorded(session_id: &str) -> Option<(u64, u64)> {
    lock(&SESSIONS)
        .as_ref()?
        .get(session_id)
        .map(|s| (s.tokens_saved, s.last_request_saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn savings_accumulate_per_conversation_and_stay_silent_until_one_lands() {
        let mut sessions = BTreeMap::new();
        apply(&mut sessions, "a", 0, 1);
        assert!(sessions.is_empty(), "a zero saving must not open an entry");

        apply(&mut sessions, "a", 15_000, 2);
        apply(&mut sessions, "b", 700, 3);
        apply(&mut sessions, "a", 0, 4);
        let a = &sessions["a"];
        assert_eq!((a.tokens_saved, a.last_request_saved), (15_000, 0));
        assert_eq!(sessions["b"].tokens_saved, 700);
    }

    #[test]
    fn least_recently_updated_conversation_is_evicted_at_the_cap() {
        let mut sessions = BTreeMap::new();
        for i in 0..MAX_SESSIONS as i64 {
            apply(&mut sessions, &format!("s{i}"), 1, i);
        }
        apply(&mut sessions, "s0", 1, 1_000);
        apply(&mut sessions, "new", 1, 1_001);
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert!(sessions.contains_key("s0"), "refreshed session was evicted");
        assert!(!sessions.contains_key("s1"), "oldest session survived");
    }
}
