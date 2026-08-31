# Windows smoke test

After installing a new Windows build (`-rc.N`), paste this file into Claude Code and ask it to run the checks. Each check has a single expected signal — if any fail, stop and investigate before promoting to stable.

Run the commands from Git Bash unless a section says PowerShell - pasting the bash blocks into a PowerShell prompt fails with `grep : The term 'grep' is not recognized` (Claude Code's Bash tool already runs Git Bash, so this only bites when running them by hand). Paths below use the Windows layout added by the Windows support work: the bundled runtime lives under `%LOCALAPPDATA%\Headroom\headroom\runtime\venv\Scripts` (`python.exe` / `headroom.exe`), RTK at `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe`, and the markitdown shim at `%LOCALAPPDATA%\Headroom\headroom\bin\markitdown.cmd`.

## Setup

1. Quit and relaunch Headroom.
2. Confirm the tray icon appears in the system tray.
3. Open the dashboard window once (so the proxy is fully booted).
4. Confirm the dashboard shows the Windows preview banner and reports `runtimeStatus.platform === "windows"` with `supportTier === "experimental"`.

## Checks (Claude Code pass)

Run these from a Claude Code session and report PASS / FAIL with the observed value. Checks 1, 5, 7, 8, 9, 10, 12, 13, and 14 are client-agnostic — run them once in either client. Check 14 has a step that must run **before** you install the rc - read it first. Codex has very different wiring (no RTK, no `%USERPROFILE%\.claude\settings.json`, pay-per-token), so its equivalents live in the **Codex pass** below; run that whole section from a Codex session.

### 1. Version matches the new build (PowerShell)
The uninstall registry key carries no `DisplayVersion` value (only MainBinaryName / DisplayName / InstallLocation / UninstallString), so grepping the registry for a version returns nothing even on a healthy install. Read the binary's version resource instead:
Two traps: `InstallLocation` comes back with embedded quotes (breaks `Join-Path`), and the binary is `$k.MainBinaryName` (`headroom-desktop.exe`), not `Headroom.exe`.
```powershell
$k = Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like '*Headroom*' }
(Get-Item (Join-Path $k.InstallLocation.Trim('"') $k.MainBinaryName)).VersionInfo.ProductVersion
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

### 4. MCP retrieve tool is available (Claude Code only)
Have Claude call `mcp__headroom__headroom_retrieve` with any small query and expect a structured tool result - an "expired or incorrect hash" error payload is a PASS; only "No such tool available" fails. MCP registration is independent of the proxy's `no-memory-tools` flag, so there is no skip gate here. (The old gate grepped log filenames for `port-6767`, which never matches - log names embed the *backend* port, 6768 or a fallback, never the intercept's 6767 - so it unconditionally reported "enabled".)

### 5. Tray → Dashboard renders
Click the tray icon, open the dashboard. Expect savings chart and per-client stats render without a blank/error state.

### 6. Pause / resume cleanly strips and restores interception
In Settings, toggle Pause then Resume. After Pause, `grep -c '127.0.0.1:6767' "$USERPROFILE/.claude/settings.json"` should return `0`; after Resume it should be non-zero. The base-URL marker exists on every install; do not grep for `headroom-rtk-rewrite` here - that hook only exists when the opt-in RTK addon is installed, so its baseline is already `0` on a fresh install. This verifies the Claude Code config only — Pause clears *all* clients, so check C4 in the Codex pass confirms Codex's config is stripped and restored too.

### 7. Proxy is actively optimizing this conversation (not just a heartbeat)
The proxy always runs in `token` mode now (`HEADROOM_MODE=token`, hardcoded). The compression policy is chosen per request by the auth-mode classifier from the client `User-Agent`: Claude Code subscription/OAuth traffic (UA `claude-code/`) is classified `SUBSCRIPTION` → conservative policy; pay-per-token API-key / Codex traffic is classified `PAYG`/`OAUTH` → aggressive policy, so `requests_compressed` and `total_tokens_removed` move directly.

Timing matters either way: a `Read` result becomes part of Claude's *next* outgoing prompt, not the one currently being composed. The baseline capture, the large Read, and the re-check cannot all happen in one turn.

Generate the payload with a real `Read` tool call. Dumping the file through Bash (`cat`, `sed`) does not work: the harness persists oversized command output to disk and only a ~2KB preview enters the next prompt, so the proxy never sees the bulk (observed on the 0.9.3-rc.5 pass).

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

### 12. Lifetime card covers "saved today" (rollup backfill regression)

Same check as beta check 16 - this class was found on a Windows install (2026-08-27: fresh `%USERPROFILE%\.headroom` under an older tracker showed a $0.50 lifetime against a $0.91 "saved today"), but it is platform-agnostic desktop logic. With the dashboard open and the backend up for a minute:

1. Visual: Home -> "Total costs saved" must be >= the chart's "saved today". Strictly less is a FAIL.
2. Cross-check against the backend's ring (Git Bash):
```bash
curl -s 127.0.0.1:6767/stats-history | jq -r --arg d "$(date -u +%Y-%m-%d)"   '[.series.daily[] | select(.timestamp | startswith($d)) | .compression_savings_usd_delta] | add // 0'
```
Expect: "saved today" in the same ballpark as this number (plus output dollars, if any); the lifetime card at or above both. Only reproduces when the tracker predates the ring (reset/recreated `.headroom`); on a truly fresh install report the visual invariant only.

### 13. Wire truth: computed transforms reached the wire, and nothing was billed for an unusable response

Windows port of beta checks 11 and 13 - see `beta-smoke-test.md` for the full rationale. This class is invisible in `/stats`, on the dashboard, and in `activity-facts.json`; the proxy log is the only place the wire truth appears. The backend writes it to `%USERPROFILE%\.headroom\logs\proxy.log`. Git Bash:

```bash
L="$USERPROFILE/.headroom/logs/proxy.log"
echo "empty-200 class: $(grep -c 'ccr_streaming_retrieve_buffered[^ ]* source=passthrough' "$L")"
echo "discards: $(grep -c 'body_mutated=true.*source=passthrough' "$L")"
grep 'body_mutated=true.*source=passthrough' "$L" | sed -n 's/.*mutation_reasons=\([^ ]*\).*/\1/p' | tr ',' '\n' | sort | uniq -c
echo "zero-output claude 200s: $(grep -c 'PERF model=claude-[^ ]* .*tok_out=0 ' "$L")"
echo "cache store refusals: $(grep -c 'response_cache_store_refused' "$L")"
```

Expect: `empty-200 class` and `cache store refusals` `0` - non-zero is a hard FAIL. `zero-output claude 200s` should also be `0`, but a non-zero count is a tripwire, not yet a verdict: the PERF line carries no status, and an upstream error passed through produces the same shape (a session-start 429 logged `tok_out=0 ttfb_ms=0` on the 0.9.3-rc.5 pass). For each matching PERF line, find the `event=proxy_inbound_response ... path=/v1/messages status=` line at the same timestamp (its `duration_ms` tracks the PERF `total_ms`; the `hr_...` and `id=inbound-...` id namespaces never join, so the timestamp is the key). `status=200` there is the bug class and a hard FAIL; a 4xx/5xx is benign. `discards` may be non-zero on the current wheel pin: FAIL only if a reason other than `output_shaper` / `image_compression` / `structural_diff_vs_original` appears (a new transform joined the silent-discard set). Promote `discards` to "expect 0" at the wheel bump that lands upstream #3015, exactly as in the beta doc; the deeper poisoned-replay probe also lives there.

### 14. User state survived the upgrade

Windows port of beta check 14 - see `beta-smoke-test.md` for the rationale. A wiped state file looks exactly like a healthy fresh one, so this needs a before/after comparison.

From 0.9.3 on, the app snapshots automatically on the first launch of a new version: raw copies of the three state files land in `%LOCALAPPDATA%\Headroom\config\pre-update\` with a `meta.json` naming the from/to versions. When the build being replaced is >= 0.9.3, verify `meta.json` and diff against that directory instead of the manual snapshot. The manual block below remains for upgrades from older builds and as a cross-check. **Run it BEFORE installing the rc**, on the build you are upgrading from (Git Bash):

```bash
S="$LOCALAPPDATA/Headroom/config"; P="$USERPROFILE/hr-preupgrade"; mkdir -p "$P"
cp "$S/headroom-pricing-state.json" "$S/client-setup.json" "$S/activity-facts.json" "$P/"
ls -l "$P"
```

**After installing and launching the rc**, compare (Git Bash; uses the bundled Python because Git Bash has no `jq`):

```bash
"$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "
import json, os, time
S = os.path.expandvars(r'%LOCALAPPDATA%\Headroom\config')
P = os.path.expandvars(r'%USERPROFILE%\hr-preupgrade')
names = ['headroom-pricing-state.json', 'client-setup.json', 'activity-facts.json']
missing = [n for n in names if not os.path.exists(os.path.join(P, n))]
if missing:
    raise SystemExit('NOT RUN - snapshot missing or wrong format (need full-file copies): ' + ', '.join(missing))
fmt = lambda t: time.strftime('%Y-%m-%d %H:%M', time.localtime(t))
snap = max(os.path.getmtime(os.path.join(P, n)) for n in names)
exe = os.path.expandvars(r'%LOCALAPPDATA%\Headroom\headroom-desktop.exe')
if os.path.exists(exe):
    print('snapshot taken', fmt(snap), '/ rc installed', fmt(os.path.getmtime(exe)))
    if snap > os.path.getmtime(exe):
        raise SystemExit('NOT RUN - snapshot is NEWER than the installed binary; it was taken after this install')
else:
    print('snapshot taken', fmt(snap), '- binary not at the default path, verify the install time by hand')
print('confirm by eye: the snapshot must come from the build you JUST replaced, not an older rc')
load = lambda d, n: json.load(open(os.path.join(d, n), encoding='utf-8'))
old, new = load(P, 'headroom-pricing-state.json'), load(S, 'headroom-pricing-state.json')
print('pricing first_seen_at:', 'OK' if old.get('first_seen_at') == new.get('first_seen_at') else 'CHANGED')
old, new = load(P, 'client-setup.json'), load(S, 'client-setup.json')
keys = lambda d, k: sorted((d.get(k) or {}).keys())
ok = keys(old, 'configuredClients') == keys(new, 'configuredClients') and keys(old, 'managedShellFiles') == keys(new, 'managedShellFiles')
print('client-setup key sets:', 'OK' if ok else 'CHANGED')
old, new = load(P, 'activity-facts.json'), load(S, 'activity-facts.json')
ok = old.get('allTimeRecordTokens') == new.get('allTimeRecordTokens') and old.get('lastWeeklyRecapWeekKey') == new.get('lastWeeklyRecapWeekKey')
print('activity-facts records/recap:', 'OK' if ok else 'CHANGED')
print('corrupt files:', sum(f.endswith('.corrupt') for f in os.listdir(S)))
"
```

Expect: three `OK` lines and `corrupt files: 0`. Only `first_seen_at`, the two key sets, and the two activity-facts fields are compared - `paywall_first` (server-owned) and a `schemaVersion` tile reset may legitimately change. The snapshot dir survives across rcs, so check its mtimes first: if they predate the build you just replaced, say so in the report rather than claiming this rc preserved state.

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
- Two log locations, not one bug: `%LOCALAPPDATA%\Headroom\headroom\logs\` holds the desktop-managed per-launch logs (filenames embed the *backend* port - 6768 or a fallback, never 6767 - plus the launch flags), while the live rotating wire-truth log that check 13 reads is `%USERPROFILE%\.headroom\logs\proxy.log`. The proxy answers `/stats` on 6767 because that is the intercept; the Python backend behind it is what the filename names.
- RTK missing → check `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe` exists; the managed blocks in `%USERPROFILE%\.claude\settings.json` / `%USERPROFILE%\.codex\config.toml` are intact.
- MCP tool missing → restart Claude Code; the MCP server registration happens at session start.
- Credential Manager entries missing → re-run sign-in; verify the app is the release (non-debug) build, since the Windows keyring module is only compiled in release builds.
- Check 13 non-zero → the regression is in the bundled `headroom-ai`, not desktop code. Confirm the wheel version with check 8, then search upstream before assuming it is ours (see the beta doc's failure notes).
- Check 14 `CHANGED` or a non-zero corrupt count → this one is ours, and it is data loss, so stop the promotion. The fix goes on the struct (`#[serde(default)]`), never by hand-repairing the user's file.
