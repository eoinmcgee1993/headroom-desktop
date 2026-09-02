# CLAUDE.md - headroom-desktop

This file holds only what the model cannot derive: project invariants, environment
quirks, and concrete commands. Generic coding-style coaching (write simply, read
before editing, state the bug and stop) was removed on 2026-08-03 — modern models do
it unprompted and the harness enforces the rest. Do not re-add it.

## Testing Rules
- After any code change, run the relevant tests/checks before declaring the task done. Do not ask the user to verify.
- Rust changes: `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>` for the affected module, plus `cargo check --manifest-path src-tauri/Cargo.toml` if the change crosses module boundaries.
- Frontend changes: `npx tsc --noEmit` and any relevant Vitest suite. For visual changes, see Styling Rules.
- If a test cannot be run in this environment, say so explicitly rather than skipping silently.

## Wheel Bump Rules
- Before changing `HEADROOM_PINNED_VERSION`: diff upstream `savings_tracker.py`, `prometheus_metrics.py`, and `server.py` between the old and new pins, and check every consumed field against `stats_contract_pins_every_consumed_path` in state.rs. Upstream has silently redefined persisted savings fields before (0.36.0 widened `compression_savings_usd`); the savings-rate canary in state.rs is the runtime tripwire, this diff is the compile-time one.
- Re-pick every platform's wheel URL/sha256 when bumping (see the pin comment in tool_manager.rs).
- Diff `rollout.py`'s FEATURES registry between the old and new pins. The app declares `HEADROOM_ROLLOUT_CHANNEL=beta` (tool_manager.rs), so any new feature with `default_enabled_in` at or below beta auto-enables for every user on the bump; any feature the app requests whose `available_in` moved above beta silently turns off (this is how 0.37.0 disabled the output shaper on stable).

## Compression / Cache Change Rules
The 0.9.4 prefix-replay regression cost every upgraded user ~17pp of their input savings rate for ~18 hours across 89 installs. All three rules below are things that, done, would have caught it before release.
- **Verify both sides of a trade.** Any change that buys one metric with another (the prefix-replay guard buys provider cache hits by spending compression) is only verified when BOTH are measured. The 0.9.4 sign-off measured cache reads and busts and never looked at `tok_saved`, so it reported "better on every metric" while compression had collapsed. Minimum evidence: `cache_read/forwarded` AND `tok_saved/tok_before`, on requests in the size band the change affects.
- **A ratio is not a measurement.** `cache_read/forwarded` falling can mean the cache broke or the conversations grew. Check the ABSOLUTE per-request figure before blaming either. A flat `cache_read` per request against a growing denominator is workload; a `cache_read` that stops scaling with conversation size is a bug (that plateau was the 0.9.4 fingerprint).
- **Soak before promoting.** Anything touching the compression or cache path waits one FULL day on staging, then `bin/rails savings:did` in headroom-web is the promotion gate (`DAY=<first full day> VERSION_PREFIX=<version>`). Release-day runs prove nothing: the day bucket is ~24h, so a same-day release is at most ~22% of it and dilutes a real effect ~4x. 0.9.4 went rc.1 to stable in six hours, which made detection structurally impossible.
- Do NOT add a client-side savings-rate canary that compares a machine against its own history. It has no control group, so a user switching models or growing conversations trips it; that was tried and produced 12 false events across 9 hosts (Sentry RUST-89/8C). The fleet DiD has a control arm, which is the entire reason it works.
- Do NOT reimplement upstream #3380 against the pinned wheel. The 0.9.4-rc.4 failure was a splice reimplementation (replay to the confirmed floor, then stitch on this turn's fresh output) that shipped every turn's beyond-floor pipeline drift and lost 22% of fleet cache coverage (1.20 -> 0.94 reads/sent, n=17, p=0.007). The sanctioned form is the sitecustomize prefix-floor VENDOR (0.9.6): the PR's overlay_cached_prefix + finalize_turn exec'd verbatim, exact-pin gated to wheel 0.37.0, pre-clamp floor bridged via prepare_turn's tracker_frozen, full-replay fallback for floorless callers, kill switch HEADROOM_PR3380_VENDOR=0, functionally tested against the installed wheel. Anything in between - partial hunks, rewritten logic, a floor derived at the overlay call site - is banned. Drop the vendor when a wheel ships #3380.

## Persistence Rules
Most stability bugs in this codebase's history were violations of one of these five. Follow them for any new code; treat violations found in existing code as bugs.
- Anything persisted uses `client_adapters::atomic_write` (tmp+rename), never plain `fs::write`. Crash mid-write must not truncate state.
- Anything versioned/deserialized carries `#[serde(default)]` (container-level where possible). One added required field must not wipe a user's history. On parse/schema failure: back the file up and log, never silently overwrite; salvage format-agnostic fields where possible.
- Anything appended (logs, JSONL) has a size cap or rotation from day one.
- Never kill a pid resolved from a port without verifying its identity (argv/process name) first.
- Day/hour bucket keys must state their timezone. User-facing "days" are local (`local_day_key`); if a source is UTC-bucketed (backend rollups), key it by its UTC date and say so - never relabel one as the other.

## Formatting
- No em dashes, smart quotes, or decorative Unicode. Plain hyphens and straight quotes, so output stays copy-paste safe. Accented letters and CJK are fine when the content needs them.

## Styling Rules
- Never hardcode colors in component CSS. Use the semantic tokens defined in `:root` in `src/styles.css` (`--surface-*`, `--text-*`, `--border-*`, `--fill-*`, `--accent*`, `--warning*`, `--danger*`, `--chip-*`).
- If a needed color does not exist as a token, add it to both the `:root` block and the `@media (prefers-color-scheme: dark)` override — do not inline a hex/rgba in a component rule.
- Exceptions: pure `#fff`/`#000`, brand gradients, and launcher/splash-only one-offs that are intentionally theme-invariant. Comment the exception inline.
- When adding or modifying a component, visually verify both light and dark mode before declaring done. If dark mode cannot be tested, say so explicitly.
- Run `npm run check:colors` (or `./scripts/check-colors.sh`) on any CSS you touch. It flags raw hex/rgba in component rules. Migrate any new offenders to tokens before committing. Existing offenders are the Stage 4 migration backlog — don't add to them.
