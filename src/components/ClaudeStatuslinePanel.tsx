import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/// On/off for the line Headroom adds under Claude Code's prompt in the terminal
/// ("Headroom: saved 15k input tokens on the last request, ..."). On by
/// default; Headroom never replaces a status line the user set up themselves.
export function ClaudeStatuslinePanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke<boolean>("get_claude_statusline_enabled")
      .then((value) => active && setEnabled(value))
      .catch(() => active && setEnabled(true));
    return () => {
      active = false;
    };
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      setEnabled(
        await invoke<boolean>("set_claude_statusline_enabled", { enabled: enabled === false })
      );
    } catch (error) {
      console.error("Failed to update the Claude Code status line", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="soft-card panel-card">
      <div className="panel-card__header">
        <div>
          <h3>Claude Code status line</h3>
          <p className="panel-card__subtitle">
            Show what Headroom saved in each conversation under the prompt in the Claude Code
            terminal. Not shown in the VS Code panel, or if you already use your own status line.
          </p>
        </div>
        <button
          aria-checked={enabled ?? true}
          aria-label={`${enabled === false ? "Enable" : "Disable"} the Claude Code status line`}
          className={`connector-switch${enabled === false ? "" : " is-on"}`}
          disabled={enabled === null || busy}
          onClick={() => void toggle()}
          role="switch"
          type="button"
        >
          <span className="connector-switch__thumb" />
        </button>
      </div>
    </article>
  );
}
