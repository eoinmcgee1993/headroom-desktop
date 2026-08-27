# Windows smoke test

After installing a new Windows build (`-rc.N`), paste this file into Claude Code and ask it to run the checks. Each check has a single expected signal — if any fail, stop and investigate before promoting to stable.

Run the commands from Git Bash unless a section says PowerShell. Paths below use the Windows layout added by the Windows support work: the bundled runtime lives under `%LOCALAPPDATA%\Headroom\headroom\runtime\venv\Scripts` (`python.exe` / `headroom.exe`), RTK at `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe`, and the markitdown shim at `%LOCALAPPDATA%\Headroom\headroom\bin\markitdown.cmd`.

## Setup

1. Quit and relaunch Headroom.
2. Confirm the tray icon appears in the system tray.
3. Open the dashboard window once (so the proxy is fully booted).
4. Confirm the dashboard shows the Windows preview banner and reports `runtimeStatus.platform === "windows"` with `supportTier === "experimental"`.

## Checks (Claude Code pass)

Run these from a Claude Code session and report PASS / FAIL with the observed value. Checks 1, 5, 7, 8, 9, and 10 are client-agnostic — run them once in either client. Codex has very different wiring (no RTK, no `%USERPROFILE%\.claude\settings.json`, pay-per-token), so its equivalents live in the **Codex pass** below; run that whole section from a Codex session.

### 1. Version matches the new build (PowerShell)
The uninstall registry key carries no `DisplayVersion` value (only MainBinaryName / DisplayName / InstallLocation / UninstallString), so grepping the registry for a version returns nothing even on a healthy install. Read the binary's version resource instead:
```powershell
$k = Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like '*Headroom*' }
(Get-Item (Join-Path $k.InstallLocation 'Headroom.exe')).VersionInfo.ProductVersion
```
Expect: the `-rc.N` version you just installed (the dashboard Settings page shows the same version as a cross-check). If this shows an older rc, STOP - every other check below would measure the stale build, not the one being promoted.

### 2. Proxy is intercepting this conversation
Send a trivial prompt ("say hi"), then:
```bash
stat -c '%y' "$LOCALAPPDATA/Headroom/config/activity-facts.json"
```
Expect: mtime within the last minute.

### 3. RTK is on PATH and reports savings (Claude Code only — RTK does not rewrite Codex)
RTK is an opt-in addon: bootstrap never installs it, so a fresh install has no `rtk.exe` until the user adds it from the Addons tab. That is the correct state, not a regression - skip this check when it is absent:
```bash
ls "$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" >/dev/null 2>&1 \
  && echo "RTK installed - run check" || echo "RTK NOT INSTALLED (opt-in addon) - skip this check"
```
If installed:
```bash
"$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" --version && "$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" gain | head -5
```
Expect: a version line and a gain summary, no "command not found". Claude Code's Bash tool spawns a non-login shell, so a bare `rtk` may report `command not found` even on a healthy install; call the managed `rtk.exe` by its absolute path instead.

### 4. MCP retrieve tool is available (Claude Code only; only if memory tools are enabled)
First check whether the proxy was started with memory tools:
```bash
ls "$LOCALAPPDATA/Headroom/headroom/logs/" | grep -E 'no-memory-tools' >/dev/null && echo 'memory tools DISABLED — skip this check' || echo 'memory tools enabled — run check'
```
If enabled, have Claude call `mcp__headroom__headroom_retrieve` with any small query and expect a tool result (not "No such tool available").

### 5. Tray → Dashboard renders
Click the tray icon, open the dashboard. Expect savings chart and per-client stats render without a blank/error state.

### 6. Pause / resume cleanly strips and restores interception
In Settings, toggle Pause then Resume. After Pause, `grep -c '127.0.0.1:6767' "$USERPROFILE/.claude/settings.json"` should return `0`; after Resume it should be non-zero. The base-URL marker exists on every install; do not grep for `headroom-rtk-rewrite` here - that hook only exists when the opt-in RTK addon is installed, so its baseline is already `0` on a fresh install. This verifies the Claude Code config only — Pause clears *all* clients, so check C4 in the Codex pass confirms Codex's config is stripped and restored too.

### 7. Proxy is actively optimizing this conversation (not just a heartbeat)
The proxy always runs in `token` mode now (`HEADROOM_MODE=token`, hardcoded). The compression policy is chosen per request by the auth-mode classifier from the client `User-Agent`: Claude Code subscription/OAuth traffic (UA `claude-code/`) is classified `SUBSCRIPTION` → conservative policy; pay-per-token API-key / Codex traffic is classified `PAYG`/`OAUTH` → aggressive policy, so `requests_compressed` and `total_tokens_removed` move directly.

Timing matters either way: a `Read` result becomes part of Claude's *next* outgoing prompt, not the one currently being composed. The baseline capture, the large Read, and the re-check cannot all happen in one turn.

**Claude Code subscription/OAuth traffic** (classified `SUBSCRIPTION`):
1. Capture the baseline:
   ```bash
   "$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import json,urllib.request; s=json.load(urllib.request.urlopen('http://127.0.0.1:6767/stats'))['summary']; print(json.dumps({'primary_model': s['primary_model'], 'prefix_frozen': s['uncompressed_requests']['prefix_frozen'], 'requests_compressed': s['compression']['requests_compressed'], 'cache_savings_usd': s['cost']['breakdown']['cache_savings_usd'], 'total_tokens_before': s['compression']['total_tokens_before']}, indent=2))"
   ```
2. End the turn with a large Read in flight — ask Claude to read a long file (~1300-1500 lines).
3. On the *next* turn, re-run the same command.

Expect: `primary_model` is a `claude-*` model, `cache_savings_usd` is strictly greater, `total_tokens_before` jumped by at least the size of the Read, and `prefix_frozen` + `requests_compressed` together increased by at least 1.

**Pay-per-token API-key traffic** (classified `PAYG`/`OAUTH` — the branch Codex hits):
1. Capture the baseline:
   ```bash
   "$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import json,urllib.request; s=json.load(urllib.request.urlopen('http://127.0.0.1:6767/stats'))['summary']['compression']; print(s['requests_compressed'], s['total_tokens_removed'])"
   ```
2. End the turn with the same large Read in flight (~1300-1500 lines clears the compression threshold).
3. On the *next* turn, re-run the same command.

Expect: `requests_compressed` increased by at least 1, and `total_tokens_removed` is strictly greater.

### 8. Bundled runtime is healthy
```bash
"$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/headroom.exe" --version && \
  "$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import headroom; print(headroom.__file__)"
```
Expect: a `headroom, version X.Y.Z` line and a path under `...\runtime\venv\Lib\site-packages\headroom\__init__.py`. No `ModuleNotFoundError`, no `pydantic-core` mismatch traceback.

### 9. Keychain round-trip via Windows Credential Manager
The session token lives in Windows Credential Manager (the `keyring` crate, `windows-native` feature), service `com.extraheadroom.headroom.account`, account `session-token`.
```powershell
cmdkey /list | findstr /i headroom
```
Expect: a stored credential entry for Headroom. Sign out and back in, then re-run the same command: the old entry is removed and a new one appears.

### 10. Autostart run key is managed
```powershell
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Headroom
```
Expect: check the Settings autostart toggle first - the key's presence must match it. An absent key with the toggle off is the correct managed state, not a failure; only "toggle on but key absent" (or vice versa) fails. To verify it is managed, flip the toggle both ways and confirm the value appears (pointing at the installed Headroom executable) and disappears accordingly.

### 11. Claude Code integration is intact
Always present, on every install:
```bash
grep -c '127.0.0.1:6767' "$USERPROFILE/.claude/settings.json"
grep -c 'headroom-claude-guard' "$USERPROFILE/.claude/settings.json"
ls "$USERPROFILE/.claude/hooks/" 2>/dev/null
```
Expect: both greps non-zero (the `ANTHROPIC_BASE_URL` routing env and the SessionStart guard hook), and `headroom-claude-guard.py` listed under `~/.claude/hooks/` (hooks run through Git Bash's `bash` on Windows).

Opt-in addons - same gate as check 3, skip when `bin/` is empty:
```bash
ls "$LOCALAPPDATA/Headroom/headroom/bin/" 2>/dev/null
grep -c 'headroom-rtk-rewrite' "$USERPROFILE/.claude/settings.json"
grep -c 'markitdown' "$USERPROFILE/.claude/settings.json"
```
Expect: non-zero only when the RTK / markitdown addons are installed; `0` on a fresh install is the correct state, not a failure. When markitdown is installed, a prompt that Reads an Office file should route through the shim and report compressed input.

## Codex checks (Codex pass)

Run these from a Codex CLI session. Codex routes through Headroom via an `OPENAI_BASE_URL` shell export plus a managed provider block in `%USERPROFILE%\.codex\config.toml`, and its traffic is pay-per-token, so the proxy runs it in `token` mode.

### C1. Codex is configured to route through Headroom
```bash
grep -q 'model_provider = "headroom"' "$USERPROFILE/.codex/config.toml" && \
  grep -q 'openai_base_url = "http://127.0.0.1:6767/v1"' "$USERPROFILE/.codex/config.toml" && \
  grep -qF '[model_providers.headroom]' "$USERPROFILE/.codex/config.toml" && \
  grep -q 'supports_websockets = false' "$USERPROFILE/.codex/config.toml" && \
  echo PASS || echo FAIL
```
Expect: `PASS`.

### C2. Codex traffic is actively optimized (token mode)
1. Capture the baseline:
   ```bash
   "$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import json,urllib.request; s=json.load(urllib.request.urlopen('http://127.0.0.1:6767/stats'))['summary']; print(json.dumps({'mode': s['mode'], 'primary_model': s['primary_model'], 'requests_compressed': s['compression']['requests_compressed'], 'total_tokens_removed': s['compression']['total_tokens_removed']}, indent=2))"
   ```
2. End the turn with a large file read in flight from Codex (~1300-1500 lines).
3. On the next turn, re-run the same command.

Expect: `mode` is `token`, `primary_model` is a `gpt-*` model, `requests_compressed` increased by at least 1, and `total_tokens_removed` is strictly greater.

### C3. Codex savings are attributed on the dashboard
Open the dashboard and confirm a **Codex** group appears in the per-provider savings with non-zero values. Provider `openai` maps to the Codex group.

### C4. Pause / resume cleanly strips and restores Codex routing
In Settings, toggle Pause then Resume, checking after each:
```bash
grep -c 'headroom:codex_cli' "$USERPROFILE/.codex/config.toml"
```
Expect: after Pause it prints `0`; after Resume it is non-zero (back to `4` marker lines).

## Inspecting the proxy directly

A fresh Windows install has neither `rtk.exe` (opt-in addon) nor `jq` (not bundled with Git Bash), so use the bundled Python to hit `/stats`:

```bash
"$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:6767/stats'))['summary'], indent=2))"
```

If RTK *is* installed, its rewrite hook filters large `curl` output into a type-shape view that looks like a broken endpoint; bypass it with `"$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" proxy curl -s http://127.0.0.1:6767/stats`. Python invocations are never rewritten, so the command above is safe either way.

## When something fails

- Proxy log silent → check `%LOCALAPPDATA%\Headroom\headroom\logs\` for a newer log file or a crash file.
- RTK missing → check `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe` exists; the managed blocks in `%USERPROFILE%\.claude\settings.json` / `%USERPROFILE%\.codex\config.toml` are intact.
- MCP tool missing → restart Claude Code; the MCP server registration happens at session start.
- Credential Manager entries missing → re-run sign-in; verify the app is the release (non-debug) build, since the Windows keyring module is only compiled in release builds.
