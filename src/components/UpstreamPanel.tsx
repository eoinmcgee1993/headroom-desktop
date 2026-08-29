import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { UpstreamMode, UpstreamOverrideView } from "../lib/types";

const MODES: { id: UpstreamMode; label: string; help: string }[] = [
  {
    id: "off",
    label: "Off",
    help: "Use Anthropic, or whatever provider cc-switch selects.",
  },
  {
    id: "fallback",
    label: "Fallback",
    help: "Start on this provider, but let a cc-switch provider switch take over.",
  },
  {
    id: "override",
    label: "Override",
    help: "Always use this provider, even after a cc-switch provider switch.",
  },
];

/// Settings for an Anthropic-compatible provider (GLM, Kimi, DeepSeek) that
/// Headroom should route to. Saving restarts the proxy: the upstream is read
/// at boot, so a running proxy keeps serving the previous one.
export function UpstreamPanel() {
  const [mode, setMode] = useState<UpstreamMode>("off");
  const [baseUrl, setBaseUrl] = useState("");
  const [hasToken, setHasToken] = useState(false);
  // Empty means "leave the stored token alone", which is why the field starts
  // blank even when one is set. Only a touched field is ever sent.
  const [token, setToken] = useState("");
  const [tokenTouched, setTokenTouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: UpstreamOverrideView) => {
    setMode(next.mode);
    setBaseUrl(next.baseUrl);
    setHasToken(next.hasToken);
    setToken("");
    setTokenTouched(false);
  }, []);

  useEffect(() => {
    let active = true;
    void invoke<UpstreamOverrideView>("get_upstream_override")
      .then((current) => {
        if (active) {
          apply(current);
        }
      })
      .catch((err) => {
        if (active) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [apply]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await invoke<UpstreamOverrideView>("save_upstream_override", {
        mode,
        baseUrl,
        token: tokenTouched ? token : null,
      });
      apply(saved);
      setNotice(
        saved.mode === "off"
          ? "Provider override removed. Headroom restarted on the default upstream."
          : "Saved. Headroom restarted on this provider.",
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [apply, baseUrl, mode, token, tokenTouched]);

  const fieldsDisabled = busy || mode === "off";

  return (
    <article className="soft-card panel-card">
      <div className="panel-card__header">
        <div>
          <h3>Provider</h3>
          <p className="panel-card__subtitle">
            Route Headroom at an Anthropic-compatible endpoint instead of Anthropic.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="upstream-panel__meta">Loading…</p>
      ) : (
        <div className="upstream-panel">
          <fieldset className="upstream-panel__modes" disabled={busy}>
            <legend className="upstream-panel__legend">When cc-switch changes provider</legend>
            {MODES.map((option) => (
              <label className="upstream-panel__mode" key={option.id}>
                <input
                  checked={mode === option.id}
                  name="upstream-mode"
                  onChange={() => setMode(option.id)}
                  type="radio"
                  value={option.id}
                />
                <span>
                  <strong>{option.label}</strong>
                  <span className="upstream-panel__mode-help">{option.help}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="upstream-field">
            <span>Base URL</span>
            <span className="upstream-field__input">
              <input
                aria-label="Provider base URL"
                autoComplete="off"
                disabled={fieldsDisabled}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.z.ai/api/anthropic"
                spellCheck={false}
                type="text"
                value={baseUrl}
              />
            </span>
          </label>

          <label className="upstream-field">
            <span>Auth token</span>
            <span className="upstream-field__input">
              <input
                aria-label="Provider auth token"
                autoComplete="off"
                disabled={fieldsDisabled}
                onChange={(event) => {
                  setToken(event.target.value);
                  setTokenTouched(true);
                }}
                placeholder={hasToken ? "Stored — type to replace" : "Paste the provider token"}
                spellCheck={false}
                type="password"
                value={token}
              />
            </span>
          </label>
          <p className="upstream-panel__meta">
            Kept in your OS keychain and written to ~/.claude/settings.json, which is
            where your client reads it from. Headroom forwards the token your client
            sends and never adds one of its own.
          </p>

          <div className="upstream-panel__actions">
            <button
              className="secondary-button secondary-button--small"
              disabled={busy}
              onClick={() => void save()}
              type="button"
            >
              {busy ? "Saving…" : "Save and restart"}
            </button>
            {hasToken && mode !== "off" ? (
              <button
                className="addon-card__link"
                disabled={busy}
                onClick={() => {
                  setToken("");
                  setTokenTouched(true);
                }}
                type="button"
              >
                Remove stored token
              </button>
            ) : null}
          </div>

          {mode !== "off" ? (
            <p className="upstream-panel__meta">
              Third-party endpoints run lossless compaction only, so payloads stay close
              to what your client sent.
            </p>
          ) : null}
          {error ? <p className="install-progress__error">{error}</p> : null}
          {notice ? <p className="install-progress__notice">{notice}</p> : null}
        </div>
      )}
    </article>
  );
}
