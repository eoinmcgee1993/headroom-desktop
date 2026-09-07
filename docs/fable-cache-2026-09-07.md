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
does not rerun the entire pipeline or measure actual provider cache reads. The
patch is not installed into the running proxy, released, or provider-soaked.
The required full staging day and fleet DiD remain release-promotion gates.
The investigation does not establish the date this client behavior first rolled
out or the exact extra subscription quota charged.
