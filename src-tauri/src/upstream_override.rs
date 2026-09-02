//! Spawn-visible copy of the user's configured upstream, plus its token.
//!
//! `tool_manager` builds the backend's environment with no `AppState` in hand
//! -- the same problem the backend port has -- so the configured override is
//! published here whenever it is loaded or changed, and read back at spawn.
//!
//! The token never enters this cache or `launch-profile.json`. It lives in the
//! OS keychain, and the only copy outside it is the one the client itself
//! needs: `env.ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`, which is
//! where cc-switch and hand-configured setups already keep it. Headroom does
//! not put it on the wire itself -- the proxy forwards whatever the client
//! sent.

use parking_lot::Mutex;

use crate::state::UpstreamOverride;

const UPSTREAM_KEYCHAIN_SERVICE: &str = "com.extraheadroom.headroom.upstream";
const UPSTREAM_TOKEN_ACCOUNT: &str = "auth-token";

static CURRENT: Mutex<Option<UpstreamOverride>> = Mutex::new(None);

/// Publish the override for the next spawn. Called on profile load and on
/// every change, so a spawn never reads a stale upstream.
pub fn publish(next: UpstreamOverride) {
    *CURRENT.lock() = Some(next);
}

/// The configured override, or the default (Off) before anything published --
/// which is also the right answer for a launch that never loads a profile.
pub fn get() -> UpstreamOverride {
    CURRENT.lock().clone().unwrap_or_default()
}

pub fn read_token() -> Option<String> {
    match crate::keychain::read_secret(UPSTREAM_KEYCHAIN_SERVICE, UPSTREAM_TOKEN_ACCOUNT) {
        Ok(token) => token.filter(|t| !t.is_empty()),
        Err(err) => {
            // Never fatal: a locked or unavailable keychain means the token
            // cannot be re-applied to the client config, not that the app
            // should fail to start.
            log::warn!("[upstream_override] reading the stored token failed: {err}");
            None
        }
    }
}

pub fn write_token(token: &str) -> Result<(), String> {
    crate::keychain::write_secret(UPSTREAM_KEYCHAIN_SERVICE, UPSTREAM_TOKEN_ACCOUNT, token)
}

pub fn delete_token() -> Result<(), String> {
    crate::keychain::delete_secret(UPSTREAM_KEYCHAIN_SERVICE, UPSTREAM_TOKEN_ACCOUNT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::UpstreamOverrideMode;

    #[test]
    #[serial_test::serial]
    fn get_defaults_to_off_before_anything_is_published() {
        *CURRENT.lock() = None;
        assert_eq!(get(), UpstreamOverride::default());
        assert_eq!(get().mode, UpstreamOverrideMode::Off);
        assert!(get().configured_upstream().is_none());
    }

    #[test]
    #[serial_test::serial]
    fn publish_is_what_the_next_spawn_reads() {
        *CURRENT.lock() = None;
        publish(UpstreamOverride {
            mode: UpstreamOverrideMode::Override,
            base_url: "https://api.z.ai/api/anthropic".into(),
            has_token: true,
            ..Default::default()
        });
        assert_eq!(
            get().configured_upstream(),
            Some("https://api.z.ai/api/anthropic")
        );
        assert!(get().pins_upstream());
        *CURRENT.lock() = None;
    }
}
