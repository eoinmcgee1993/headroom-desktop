# Fable cache-loss investigation, September 7, 2026

## Finding

Claude Code's temporary trailing system messages make Headroom 0.37.0 lose the
existing conversation tracker. This reproduced offline against the actual last
good request and first bad request, and explains all 27 repeated cache-loss turns
in the large Fable session between 09:02 and 09:54 Europe/Amsterdam (UTC+02:00).

This is a compatibility defect in Headroom's conversation matching. The trigger
comes from Claude Code, but Headroom amplifies a change at the end of the prompt
into changes near the beginning of the cached history. It is not simply normal
cache expiry, a large-token display, or a failure to attach cache breakpoints.

No live Claude requests or subscription usage were needed for this investigation.
The fix is now in the desktop source. No running configuration was changed.

## Evidence

The proxy retained the original and forwarded messages. Three relevant captures:

| Response time, Amsterdam | Proxy request ID | Cache read | Cache write |
| --- | --- | ---: | ---: |
| 09:02:17 | `hr_1788764464_000134` | 0 | 490,996 |
| 09:04:20 | `hr_1788764590_000155` | 490,996 | 12,509 |
| 09:05:39 | `hr_1788764673_000174` | 7,259 | 491,260 |

The 09:04 request contains 862 messages. Its last message is a temporary
`role: system` reminder to plan independent tool calls and request them together.
The exact reminder text is present in the installed Claude Code 2.1.259 native
binary and absent from the searched Headroom runtime and desktop source.

On the next request, the first 861 original messages are semantically identical.
The temporary system message at index 861 is replaced by the next assistant
response; a fresh system reminder appears at the new end of the request.

Headroom's recorded forwarded messages nevertheless differ at 100 historical
positions under its own canonical comparison. The first difference is at index
3: a previously forwarded compressed Read marker becomes the original longer
tool result. The incoming message at that index did not change. That explains
why reuse collapses near the start of the conversation rather than only at the
temporary reminder near its end.

Across the 30 successful large Fable requests in the window:

- One initial cold request.
- Two `message_append` continuations: 1,066,873 cache-read tokens and 18,314 writes.
- Twenty-seven `diverged` continuations after a temporary trailing system
  reminder: 195,993 cache-read tokens and 15,183,730 writes.
- Each of the 27 becomes `message_append` when only the previous temporary
  trailing system message is excluded from the comparison. Twenty-three use the
  batching reminder alone; four combine it with progress or changed-file notices.
- Overall: 1,262,866 cache-read tokens, 15,693,040 cache-write tokens, and 4,291
  uncached input tokens. Cache reuse is 7.4% of provider-reported input.
- The same requests report 450,271 message-compression tokens saved out of
  15,343,345 pre-compression tokens, or 2.93%. These are Headroom's estimates,
  not a measurement of a hypothetical no-proxy provider bill.

After the switch to Opus, the captured requests do not carry the batching
reminder and resume append-only matching. The first seven warm Opus requests
have 98.53% provider cache reuse. That is an observed contrast, not a controlled
model benchmark.

## Mechanism and offline reproduction

Follow-up chronology check: the incident conversation records Claude Code
2.1.241 on September 2 and 2.1.259 from September 3 at 10:29 Amsterdam onward.
The retained proxy captures already contain the batching reminder on September 6
at 17:29:46 Amsterdam, the start of the retained capture window. It therefore
predates the reported September 7 hour; this retention window cannot establish
its first-ever appearance. The exact string is also present in the currently
available desktop-bundled 2.1.258 and 2.1.260 binaries. The specific release or
feature rollout that activated it remains unverified.

The installed wheel is `headroom-ai==0.37.0`. The running proxy started on
September 6 at 17:28:28 Amsterdam time, before September 7's desktop commits.
The installed desktop prefix-floor vendor is bound to that wheel.

1. `headroom/cache/prefix_tracker.py::_classify_history_canonical` accepts exact
   history, message appends, block appends, and a narrow same-message-count tail
   rewrite. It rejects replacement of a previous trailing system message.
2. `SessionTrackerStore.resolve_tracker` therefore allocates a fresh tracker
   despite the unchanged session ID, model/tools/thinking affinity, and historical
   prefix. The tracker has no previous forwarded messages and freezes zero.
3. The Anthropic handler then processes old history again. Background compression,
   stale-read handling, and other transformations can change previously cached
   bytes. `finalize_turn` has no previous tracker state to replay.
4. The provider reports a near-full cache rewrite. The temporary reminder moves
   again next turn, so the cycle repeats.

The reproducer holds cache affinity constant to isolate the disappearing system
suffix. It seeds confirmed cache state without any provider calls, then verifies
that the next real request gets a different tracker with zero frozen messages.

As a counterfactual, supplying the previous tracker to the installed vendor's
existing `overlay_cached_prefix` restores all 861 unchanged historical messages
and leaves the current tail, including its current reminder, untouched. The
vendor already stops replay at the first actual divergence. Its replay algorithm
does not need to be rewritten to demonstrate the missing tracker state.

Run the synthetic reproducer using a Python environment with Headroom 0.37.0:

```sh
python scripts/reproduce-transient-system-cache.py
```

To exercise the exact installed desktop vendor, add
`--sitecustomize /path/to/headroom/pyinject/sitecustomize.py`. To replay the private
three-request capture, also add `--capture /path/to/three-requests.json`.
The capture is stored outside the repository because it contains conversation
contents. The default synthetic fixture contains no private user data.

The script exits zero when the historical failure and the counterfactual are
both demonstrated. This is a diagnostic reproducer, not a passing assertion that
the installed runtime is fixed. It blocks socket connections and name resolution.

## Fix boundary and limitations

The fix belongs in conversation-tracker selection: recognize a continuation of
an unchanged prefix when a temporary trailing system message is replaced, without
discarding its previous replay state. Keep the current system message on the
wire, preserve genuinely changed historical instructions, keep different tool
affinities isolated, and reject ambiguous sibling-conversation matches.

Do not indiscriminately remove all system messages or force unrelated histories
onto one tracker. Do not replace the sanctioned prefix-floor vendor with another
splice. Add the transient-system case to tracker-selection regression coverage
and exercise the existing replay with a moving and changing system suffix.

## Implemented fix and validation

`src-tauri/src/tool_manager.rs` now injects a narrow resolver fallback for the
0.37.0 wheel. Existing exact, append, block-append, and block-rewrite matching
take precedence. Otherwise, a previous trailing system message may be excluded
from matching only when its entire preceding history matches the current
prefix and includes a user or assistant message. The uniquely longest candidate
wins; equal-length sibling candidates remain separate. Cache affinity, expiry,
and capacity still follow the wheel's existing rules. OpenAI is unaffected.

The original resolver records the full current snapshot. No instruction is
removed from the request, and the sanctioned #3380 overlay is unchanged.
`HEADROOM_TRANSIENT_SYSTEM_LINEAGE=0` disables this compatibility fallback.
Reassess/remove the exact-pin shim when upgrading the wheel.

The diagnostic now supports `--expect-fixed`, which requires tracker retention
and runs isolation checks. The Rust test
`transient_system_lineage_behaves_against_the_installed_wheel` loads the actual
embedded injection and runs that mode against the installed managed Python.

Validation on September 7, 2026:

- Synthetic regression and real 862-to-864-message capture pass. The latter
  preserves all 861 unchanged historical messages under the runtime's canonical
  comparison and leaves the current tail untouched.
- Disabling the shim makes `--expect-fixed` fail at tracker retention, proving
  the regression check detects the original defect.
- All 27 successful cache-loss transitions pass pairwise offline replay. One
  later captured transition without successful provider usage also passes.
- Different affinities, changed historical/leading system messages, other
  providers, ordinary appends, moving/changing reminders, full stored snapshots,
  ambiguous siblings, exact-match precedence, expiry, and capacity are checked.
- Existing prefix-floor checks pass, including allowing compression improvements
  beyond the confirmed floor.
- Across the 28 pairwise replays, the runtime's rough character-based token
  estimator measures 9,267,797 original tokens, 8,788,206 recorded-output tokens,
  and 8,800,746 replayed-output tokens. Estimated compression is 5.17% before
  versus 5.04% after replay: preserving the prior compressed bytes trades a small
  amount of additional compression for cache stability. These estimates use a
  different accounting method from the recorded 2.93% above.

Pairwise replay seeds a confirmed floor and uses captured compressor output; it
does not rerun the entire pipeline or measure actual provider cache reads.
The live test below subsequently verified the installed lineage fix. The required
full staging day and fleet DiD remain release-promotion gates.
The investigation does not establish the date this client behavior first rolled
out or the exact extra subscription quota charged.

## Live verification, September 7, 11:28-11:34 Amsterdam

The restarted proxy contains the transient-system lineage repair. The user's
three test prompts produced 13 main Fable model requests, with input growing
from about 32k to 82k estimated tokens. Nine transitions replaced a trailing
system reminder. Across 157 unchanged historical message positions, there were
zero canonical changes to forwarded content.

The 12 requests after the initial cold request report 664,386 cache-read tokens,
49,646 cache-write tokens, and 472 uncached input tokens: 92.99% provider cache
reuse. Absolute reads grow from 32,789 to 80,423 per request. The proxy records
7,002 gross compression tokens removed across 715,612 original input tokens
(0.98%); this repeats historical removals and is not first-appearance savings.
This verifies cache retention at the tested size, not the entire fleet or the
earlier 500k-token size band.

## Fleet investigation and new Sentry diagnostic

Read-only production queries used daily aggregates, with no user IDs or request
contents exported. During September 1-7 (September 7 incomplete), 248 non-admin
accounts had at least one day with >=1 million tokens sent and reported cache
counts. Twelve had at least one day where cache reads / tokens sent was below
0.2, comprising 14 user-days. One such user-day falls on September 6 and none
on September 7 so far. Fleet daily median coverage remained around 0.91-0.93
over September 3-7. The daily keys can mix local and UTC attribution; they are
not exact UTC windows. This coverage metric is not provider cache-hit rate.

These are low-coverage candidates, not confirmed instances of this defect.
Existing fleet data combines models and conversations and lacks the historical
prefix comparisons needed for attribution. Searching recent Sentry cache issues
did not identify a report diagnosing this mechanism.

The new observer in `SITECUSTOMIZE_PY` independently watches tracker selection
and successful response accounting. It records a diagnostic when an unchanged
original message inside the prior confirmed cache floor has different forwarded
content, cache reads fell below the previous cached amount, and new cache writes
occurred before the conservative TTL deadline. It checks retained trackers and
can recover evidence after a reset for the proven system-tail shape. Arbitrary
new sibling lineages are intentionally not classified as regressions.

Only counters, positions, a reason enum, and a random proxy boot identifier
leave the observer through `prefix_cache.desktop_integrity` in `/stats`. The
desktop parses an allowlist and emits the Warning-level Sentry message
`Headroom rewrote an unchanged cached prefix`, grouped by
`cache-prefix-integrity` plus `tracker_reset` or `prefix_rewrite`. The first
observation reports on the next successful dashboard stats poll. Unchanged
snapshots are deduplicated; additional observations are limited to one event
per hour per desktop process, even across proxy restarts.

The observer neither changes traffic nor sends network requests. It is gated
to wheel 0.37.0 with kill switch `HEADROOM_CACHE_INTEGRITY=0`; wheel upgrades
must revalidate the hook. It does not diagnose provider eviction, changed tools
or system headers, all possible lineage resets, or failures that never produce
usage. Its in-memory diagnostics do not survive a proxy restart before polling.

Validation: synthetic checks pass with the repair on and off; the captured
original failure is detected at message index 3. Stable replay, beyond-floor
compression, uncached assistant responses, changed originals/affinity, expiry,
concurrent contexts, and
observer exceptions are checked. A local Sentry transport test captures one
properly grouped event with no prompt text and no network delivery. Relevant
Rust tests, formatting, and cross-module `cargo check` pass. The new observer
and desktop Sentry reporter are implemented in source, not yet deployed.
