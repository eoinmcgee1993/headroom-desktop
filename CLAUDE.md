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
- Diff `headroom/transforms/` between the pins. This is the compression ENGINE and nothing else in these rules covers it. The 0.35.0 -> 0.37.0 bump changed it by +421 lines (`content_router.py` +174, `mixed_content.py` +101, `kompress_compressor.py` +59, `compression_policy.py` +55) and shipped unexamined. Measured consequence, model and size band held constant so workload is not the explanation: fable-5 500k+ compression fell from 4.64% (25,631 tokens/request) to 0.45% (2,463) across the swap. **The cause is still UNISOLATED** as of 2026-09-02. Four hypotheses have been tested and refuted, so do not restate any of them as fact: (1) the prefix-replay guard -- refuted, the drop is identical on full-replay and floor builds; (2) workload/model mix -- refuted by matching model and size band; (3) the TTL-aware net-cost gate (`CACHE_WRITE_MULTIPLIER_1H`, upstream #2780) -- refuted, that gate is flag-gated behind `HEADROOM_NET_COST_POLICY=1`, is NOT set, and emits zero `netcost:skip` markers across 925 logged requests; (4) more content being protected -- refuted, `router:protected` runs 0.35/request before and 0.32/request after. Next step if this is picked up: bisect 0.36.0..0.36.5 against a fixed replayed workload rather than reasoning from diffs.
- The #3380 prefix-floor vendor is exact-pin gated to wheel `0.37.0`. Any bump makes it INERT, silently: replay falls back to the full-replay guard, compression drops by roughly half (measured 13,568 -> 6,831 tokens/request on the 0.9.4->0.9.5 swap), and nothing errors. So on every bump, check whether the new wheel actually carries #3380: if it does, delete the vendor; if it does not, re-pin the vendor to the new version and re-run `cargo test --manifest-path src-tauri/Cargo.toml --lib vendored_prefix_floor` against the installed runtime. That test self-skips when the vendor does not bind, so a green suite is NOT evidence the floor still works after a bump.

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
