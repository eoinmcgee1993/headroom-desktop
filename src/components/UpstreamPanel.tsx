import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ProviderPresetView, UpstreamOverrideView } from "../lib/types";

/// Sentinel for "an endpoint the presets do not cover", where the user brings
/// the URL and model ids themselves.
const CUSTOM = "custom";

/// Settings for an Anthropic-compatible provider (GLM, Kimi, MiniMax, DeepSeek)
/// that Headroom should route to. Picking one writes its URL, model slots and
/// context window, so the user only supplies a token; picking Anthropic clears
/// all of it. Saving restarts the proxy -- the upstream is read at boot, so a
/// running proxy keeps serving the previous one.
export function UpstreamPanel() {
  const [providers, setProviders] = useState<ProviderPresetView[]>([]);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [contextWindow, setContextWindow] = useState("");
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
    setProviders(next.providers);
    // A saved endpoint with no preset id was entered by hand.
    setProvider(next.provider || (next.baseUrl ? CUSTOM : ""));
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setContextWindow(next.contextWindow);
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

  const preset = useMemo(
    () => providers.find((entry) => entry.id === provider),
    [provider, providers],
  );
  // Custom without a URL is not a provider, same as picking Anthropic.
  const configured = preset !== undefined || (provider === CUSTOM && baseUrl.trim() !== "");

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await invoke<UpstreamOverrideView>("save_upstream_override", {
        // Off clears the stored URL, token and model ids backend-side, so
        // picking Anthropic is how the user turns the provider back off.
        mode: configured ? "override" : "off",
        // A preset supplies the URL and models; these fields only carry a
        // hand-entered endpoint.
        provider: preset ? preset.id : "",
        baseUrl,
        token: tokenTouched ? token : null,
        model,
        contextWindow,
      });
      apply(saved);
      setNotice(
        saved.mode === "off"
          ? "Provider removed. Headroom restarted on Anthropic."
          : "Saved. Headroom restarted on this provider.",
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [apply, baseUrl, configured, contextWindow, model, preset, token, tokenTouched]);

  return (
    <article className="soft-card panel-card">
      <div className="panel-card__header">
        <div>
          <h3>Provider</h3>
          <p className="panel-card__subtitle">
            Route Headroom at an Anthropic-compatible endpoint instead of Anthropic.
            Pick one and paste its token; pick Anthropic to switch back.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="upstream-panel__meta">Loading…</p>
      ) : (
        <div className="upstream-panel">
          <label className="upstream-field">
            <span>Provider</span>
            {/* Native select: it picks up the system light/dark chrome and
                keyboard behaviour without any styling of our own. */}
            <select
              aria-label="Provider"
              disabled={busy}
              onChange={(event) => setProvider(event.target.value)}
              value={provider}
            >
              <option value="">Anthropic (default)</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              <option value={CUSTOM}>Other (enter a URL)</option>
            </select>
          </label>

          {provider === CUSTOM ? (
            <>
              <label className="upstream-field">
                <span>Base URL</span>
                <span className="upstream-field__input">
                  <input
                    aria-label="Provider base URL"
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.z.ai/api/anthropic"
                    spellCheck={false}
                    type="text"
                    value={baseUrl}
                  />
                </span>
              </label>

              <label className="upstream-field">
                <span>Model (optional)</span>
                <span className="upstream-field__input">
                  <input
                    aria-label="Provider model"
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="glm-5.3[1m]"
                    spellCheck={false}
                    type="text"
                    value={model}
                  />
                </span>
              </label>

              <label className="upstream-field">
                <span>Context window (optional)</span>
                <span className="upstream-field__input">
                  <input
                    aria-label="Provider context window"
                    autoComplete="off"
                    disabled={busy}
                    inputMode="numeric"
                    onChange={(event) => setContextWindow(event.target.value)}
                    placeholder="1000000"
                    spellCheck={false}
                    type="text"
                    value={contextWindow}
                  />
                </span>
              </label>
              <p className="upstream-panel__meta">
                Leave the model empty if your provider already answers to Claude model
                names.
              </p>
            </>
          ) : null}

          {provider === "" ? null : (
            <label className="upstream-field">
              <span>Auth token</span>
              <span className="upstream-field__input">
                <input
                  aria-label="Provider auth token"
                  autoComplete="off"
                  disabled={busy}
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
          )}

          {preset ? (
            <p className="upstream-panel__meta">
              Sets {preset.baseUrl} and {preset.model} in ~/.claude/settings.json. If your
              plan serves a different model, pick Other and name it.
            </p>
          ) : null}

          {provider === "" ? null : (
            <p className="upstream-panel__meta">
              The token is kept in your OS keychain and written to ~/.claude/settings.json,
              which is where your client reads it from. Headroom forwards the token your
              client sends and never adds one of its own.
            </p>
          )}

          <div className="upstream-panel__actions">
            <button
              className="secondary-button secondary-button--small"
              disabled={busy}
              onClick={() => void save()}
              type="button"
            >
              {busy ? "Saving…" : "Save and restart"}
            </button>
            {hasToken && configured ? (
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

          {configured ? (
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
