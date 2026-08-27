# Windows smoke test

After installing a new Windows build (`-rc.N`), paste this file into Claude Code and ask it to run the checks. Each check has a single expected signal — if any fail, stop and investigate before promoting to stable.

Run the commands from Git Bash unless a section says PowerShell. Paths below use the Windows layout added by the Windows support work: the bundled runtime lives under `%LOCALAPPDATA%\Headroom\headroom\runtime\venv\Scripts` (`python.exe` / `headroom.exe`), RTK at `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe`, and the markitdown shim at `%LOCALAPPDATA%\Headroom\headroom\bin\markitdown.cmd`.

## Setup

1. Quit and relaunch Headroom.
2. Confirm the tray icon appears in the system tray.
3. Open the dashboard window once (so the proxy is fully booted).
4. Confirm the dashboard shows the Windows preview banner and reports `runtimeStatus.platform === "windows"` with `supportTier === "experimental"`.

## Checks (Claude Code pass)

Run these from a Claude Code session and report PASS / FAIL with the observed value. Check 13 has a step that must run **before** you install the rc - read it first. Checks 1, 5, 7, 8, 9, 10, 12, 13, and 14 are client-agnostic — run them once in either client. Codex has very different wiring (no RTK, no `%USERPROFILE%\.claude\settings.json`, pay-per-token), so its equivalents live in the **Codex pass** below; run that whole section from a Codex session.

### 1. Version matches the new build
```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f Headroom 2>/dev/null | grep -i version
```
Expect: the `-rc.N` version you just installed.

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
In Settings, toggle Pause then Resume. After Pause, `grep -c headroom-rtk-rewrite "$USERPROFILE/.claude/settings.json"` should return `0`; after Resume it should return `1`. This verifies the Claude Code config only — Pause clears *all* clients, so check C4 in the Codex pass confirms Codex's config is stripped and restored too.

### 7. Proxy is actively optimizing this conversation (not just a heartbeat)
The proxy always runs in `token` mode now (`HEADROOM_MODE=token`, hardcoded). The compression policy is chosen per request by the auth-mode classifier from the client `User-Agent`: Claude Code subscription/OAuth traffic (UA `claude-code/`) is classified `SUBSCRIPTION` → conservative policy; pay-per-token API-key / Codex traffic is classified `PAYG`/`OAUTH` → aggressive policy, so `requests_compressed` and `total_tokens_removed` move directly.

Timing matters either way: a `Read` result becomes part of Claude's *next* outgoing prompt, not the one currently being composed. The baseline capture, the large Read, and the re-check cannot all happen in one turn.

**Claude Code subscription/OAuth traffic** (classified `SUBSCRIPTION`):
1. Capture the baseline:
   ```bash
   "$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" proxy curl -s http://127.0.0.1:6767/stats | jq '{primary_model: .summary.primary_model, prefix_frozen: .summary.uncompressed_requests.prefix_frozen, requests_compressed: .summary.compression.requests_compressed, cache_savings_usd: .summary.cost.breakdown.cache_savings_usd, total_tokens_before: .summary.compression.total_tokens_before_with_cli_filtering}'
   ```
2. End the turn with a large Read in flight — ask Claude to read a long file (~1300-1500 lines).
3. On the *next* turn, re-run the same `jq` command.

Expect: `primary_model` is a `claude-*` model, `cache_savings_usd` is strictly greater, `total_tokens_before` jumped by at least the size of the Read, and `prefix_frozen` + `requests_compressed` together increased by at least 1.

**Pay-per-token API-key traffic** (classified `PAYG`/`OAUTH` — the branch Codex hits):
1. Capture the baseline:
   ```bash
   "$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" proxy curl -s http://127.0.0.1:6767/stats | jq '.summary.compression.requests_compressed, .summary.compression.total_tokens_removed'
   ```
2. End the turn with the same large Read in flight (~1300-1500 lines clears the compression threshold).
3. On the *next* turn, re-run the same `jq` command.

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
Expect: the value points at the installed Headroom executable. Toggle autostart off in Settings and confirm the value disappears; toggle back on and confirm it returns.

### 11. Claude Code integration is intact
```bash
grep -c 'headroom-rtk-rewrite' "$USERPROFILE/.claude/settings.json"
grep -c 'markitdown' "$USERPROFILE/.claude/settings.json"
ls "$USERPROFILE/.claude/hooks/" 2>/dev/null
```
Expect: non-zero hook references for RTK rewrite and markitdown, and the hook scripts exist under `~/.claude/hooks/` (the guard hook and markitdown shim run through Git Bash's `bash` on Windows). Sending a prompt that triggers a `Read` should route through markitdown and report compressed input.

### 12. Backend port fallback when 6768 is held

The desktop's internal proxy port (default `6768`) can be claimed by another process - on Windows the historic occupant is a stranded Headroom process left behind by an update (`os error 10048`, fixed in 0.8.4). The desktop should scan `6769..=6790` and pick a free one instead of failing.

First, confirm the live port and verify the proxy answers there:
```bash
netstat -ano | grep -i listening | grep -E ':(676[8-9]|67[78][0-9]|6790)\s'
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:6767/livez"
```
Expect: at least one `127.0.0.1:67XX` line in the 6768-6790 range, and the curl returns `200`.

Then, force a fallback. Quit Headroom from the tray menu, hold 6768 with a blocker, relaunch, and confirm the proxy comes up on a different port. Adaptations and traps:

- The blocker must NOT set `SO_REUSEADDR`: on Windows that option lets a second socket bind over an active listener, so the proxy would bind straight through the block and the test would silently test nothing. A plain `bind` holds the port exclusively.
- There is no system `python3` in Git Bash; use the bundled runtime's `python.exe`.
- The quit must wait for the process to actually die before relaunching - poll `tasklist` instead of a fixed sleep.
- The proxy on a fallback port boots cold, so poll `/livez` for up to 90s, and give every curl in the loop a `--max-time` (a timeout-less curl against a half-booted intercept can hang for minutes and strand the script even after the fallback succeeded).

```bash
taskkill //IM Headroom.exe >/dev/null 2>&1   # graceful; use the tray menu if this does not exit it
for _ in $(seq 1 30); do tasklist //FI "IMAGENAME eq Headroom.exe" | grep -q Headroom.exe || break; sleep 0.5; done
"$LOCALAPPDATA/Headroom/headroom/runtime/venv/Scripts/python.exe" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',6768)); s.listen(16); time.sleep(180)" &
BLOCK_PID=$!
sleep 1
cmd //c start "" "$LOCALAPPDATA\\Headroom\\Headroom.exe"
for _ in $(seq 1 90); do
  code=$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:6767/livez" 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "livez=$code"
netstat -ano | grep -i listening | grep -E ':(676[8-9]|67[78][0-9]|6790)\s'
kill $BLOCK_PID 2>/dev/null
```
Expect: `livez=200`, and a `127.0.0.1:67XX` listener where `XX` is NOT `68` (the fallback worked). A second confirmation is the proxy log *filename*, which embeds the chosen port - a successful fallback leaves a `headroom-proxy---port-6769---....log` next to the usual `...port-6768...` one:
```bash
ls -t "$LOCALAPPDATA/Headroom/headroom/logs/" | grep -m3 'headroom-proxy---port-'
```
After the test, quit and relaunch once more with the same wait-for-exit pattern to restore the default port.

If the fallback is missing, check the desktop log for a `[backend_port]` warning line naming the occupant and the chosen fallback port. On Windows the desktop log is `%LOCALAPPDATA%\headroom\headroom-desktop.log` - note the lowercase `headroom` directory, which is NOT inside `%LOCALAPPDATA%\Headroom`. The *proxy* logs under `...\Headroom\headroom\logs\` never carry that line - it is emitted by the Rust side, so grepping the proxy log directory for `backend_port` comes back empty even on a successful fallback.

### 13. User state survived the upgrade

None of the earlier checks notice that the upgrade silently reset user state, because a wiped state file looks exactly like a healthy fresh one. Every persisted file here is read back through `serde`, so one field added or renamed in the new build is enough to fail a parse and hand the user a default: a restarted grace clock, an empty savings history, or a client-setup record that no longer knows which shell files we wrote (which is also what uninstall reads to clean up).

**Run this block BEFORE installing the rc**, on the build you are upgrading from:
```bash
S="$LOCALAPPDATA/Headroom"
mkdir -p /tmp/hr-preupgrade
jq '{first_seen_at,paywall_first}' "$S/config/headroom-pricing-state.json" > /tmp/hr-preupgrade/pricing.json
jq '{configured:(.configuredClients|keys),shell:(.managedShellFiles|keys)}' "$S/config/client-setup.json" > /tmp/hr-preupgrade/setup.json
jq '{tokens:.allTimeRecordTokens,recap:.lastWeeklyRecapWeekKey,schema:.schemaVersion}' "$S/config/activity-facts.json" > /tmp/hr-preupgrade/facts.json
# For check 14: the user's own CLAUDE.md content, excluding our managed blocks.
awk '/headroom:(learn:start|markitdown_office >>>)/{skip=1} !skip{n+=length($0)+1} /headroom:(learn:end|markitdown_office <<<)/{skip=0} END{print FILENAME, n+0}' \
  ~/.claude/CLAUDE.md > /tmp/hr-preupgrade/claude-md.txt
cat /tmp/hr-preupgrade/*.json /tmp/hr-preupgrade/claude-md.txt
```

**After installing and launching the rc**, re-run the same three `jq` expressions and diff:
```bash
S="$LOCALAPPDATA/Headroom"
stat -c '%y %n' /tmp/hr-preupgrade/*   # must predate THIS install, not an older one
diff <(jq '{first_seen_at,paywall_first}' "$S/config/headroom-pricing-state.json") /tmp/hr-preupgrade/pricing.json
diff <(jq '{configured:(.configuredClients|keys),shell:(.managedShellFiles|keys)}' "$S/config/client-setup.json") /tmp/hr-preupgrade/setup.json
jq '{tokens:.allTimeRecordTokens,recap:.lastWeeklyRecapWeekKey,schema:.schemaVersion}' "$S/config/activity-facts.json"
ls "$S/config/" | grep -c '\.corrupt$'
```
Expect: `first_seen_at` byte-identical (`paywall_first` may legitimately change - the server owns it), the configured-client and shell-file key sets unchanged, and `0` quarantine files.

Check the snapshot's mtime before trusting a clean diff. `/tmp/hr-preupgrade` (Git Bash maps `/tmp` to the user temp dir) survives across rcs, so a run that forgot the pre-install step silently diffs against a snapshot from two builds ago - which passes, but tests the wrong upgrade. If the mtime predates the build you just replaced, say so in the report rather than claiming this rc preserved state.

`activity-facts.json` is the deliberate exception: a `schemaVersion` bump intentionally drops the tile slots, so it needs its own comparison rather than a `diff`. What must survive a bump is `allTimeRecordTokens` and `lastWeeklyRecapWeekKey` - wiping those re-fires the weekly recap and resets all-time records for every user, which has happened on four bumps so far.

A non-empty `*.corrupt` listing is the highest-signal failure in this doc. `quarantine_unparsable` only creates one when a state file failed to parse and was about to be overwritten, so the file itself is the evidence: `jq . <the .corrupt file>` to see which field the new build could not read. The fix belongs on the struct (`#[serde(default)]`, per the Persistence Rules in CLAUDE.md), not on the file.

### 14. CLAUDE.md files are intact after the upgrade

Two independent writers edit the user's CLAUDE.md, and neither is a Headroom-owned file - a bad write damages the user's own instructions. The desktop's `upsert_managed_block` maintains `# >>> headroom:markitdown_office >>>` in `~/.claude/CLAUDE.md`; the Python `headroom learn` command maintains `<!-- headroom:learn:start -->` blocks in both the global and every project CLAUDE.md. Both find their markers by literal string search on the whole file, so an interrupted write, a hand-edited half-block, or a second writer racing the first duplicates markers instead of replacing the block.

Run against the global file plus any project CLAUDE.md files present on the machine:
```bash
for f in ~/.claude/CLAUDE.md; do
  echo "== $f"
  echo "  markitdown: $(grep -c '^# >>> headroom:markitdown_office >>>' "$f")/$(grep -c '^# <<< headroom:markitdown_office <<<' "$f")"
  echo "  learn:      $(grep -c '<!-- headroom:learn:start -->' "$f")/$(grep -c '<!-- headroom:learn:end -->' "$f")"
  awk '/headroom:(learn:start|markitdown_office >>>)/{skip=1} !skip{n+=length($0)+1} /headroom:(learn:end|markitdown_office <<<)/{skip=0} END{print "  user bytes outside managed blocks: " n+0}' "$f"
done
```
Expect: every pair is `0/0` or `1/1` - never `2/2` (duplicated block) and never `1/0` (truncated mid-write). The user-bytes figure has no fixed value; capture it in the check 13 pre-install snapshot and confirm it does not shrink across the upgrade.

A `2/2` is the duplicate-block bug: `strip_marker_block` loops for exactly this reason, and `upsert_managed_block` treats reordered `end`-before-`start` markers as absent and appends fresh rather than rebuilding around them. Both behaviours have unit tests, so a failure here means a new writer, not a regression in those.

Note what this check does **not** cover: CLAUDE.md damage that never reaches disk (the 0.34.0 class, where upstream's user-turn compression mangled the file's content on the wire while the file stayed intact). That is invisible to any filesystem check - catching it means reading a `/v1/messages` request body (beta smoke test check 11, not ported here).

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
   "$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" proxy curl -s http://127.0.0.1:6767/stats | jq '{mode: .summary.mode, primary_model: .summary.primary_model, requests_compressed: .summary.compression.requests_compressed, total_tokens_removed: .summary.compression.total_tokens_removed}'
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

When inspecting the running proxy by hand (e.g. checking `/stats`), wrap `curl` with `rtk proxy` to bypass RTK's output filtering — otherwise large JSON responses get summarized into a type-shape view that looks like a broken endpoint:

```bash
"$LOCALAPPDATA/Headroom/headroom/bin/rtk.exe" proxy curl -s http://127.0.0.1:6767/stats | jq .summary
```

## When something fails

- Proxy log silent → check `%LOCALAPPDATA%\Headroom\headroom\logs\` for a newer log file or a crash file.
- RTK missing → check `%LOCALAPPDATA%\Headroom\headroom\bin\rtk.exe` exists; the managed blocks in `%USERPROFILE%\.claude\settings.json` / `%USERPROFILE%\.codex\config.toml` are intact.
- MCP tool missing → restart Claude Code; the MCP server registration happens at session start.
- Credential Manager entries missing → re-run sign-in; verify the app is the release (non-debug) build, since the Windows keyring module is only compiled in release builds.
