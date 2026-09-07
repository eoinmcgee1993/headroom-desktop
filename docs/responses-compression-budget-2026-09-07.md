# Responses compression timeout follow-up

The rc3 verification exposed a separate worker timeout problem. A verified
SIGUSR1 stack dump from the running managed proxy showed the parent Responses
compression worker waiting in `as_completed`, while its unit workers were either
running Kompress ONNX inference or waiting for Kompress's execution semaphore.
It was still processing small batches after the outer request timed out.

The pinned 0.37.0 wheel starts a new 20-second deadline for each Kompress call.
A large Responses request can contain hundreds of these calls. Its outer
30-second timeout stops waiting but does not stop the worker; outstanding work
then activates compression quarantine for unrelated requests. Raising that
timeout or disabling quarantine would leave the underlying work unbounded.

## Change

The desktop injection now carries one cooperative deadline through the Responses
request executor and its nested unit executor. It uses the existing configured
compression budget, capped at 75% of the outer timeout to leave cleanup margin.
Kompress receives that same deadline for its native chunk and semaphore checks.
After expiry, router calls return the original content. Completed compression
survives, and cancellation signals the remaining unit calls to pass through.

The patch is exact-pin gated to 0.37.0. `HEADROOM_RESPONSES_SHARED_BUDGET=0`
disables it, and the existing `HEADROOM_COMPRESSION_DEADLINE_MS=0` opt-out is
respected. Unmarked compression executor calls retain their previous behavior.
The sanctioned prefix-floor vendor is unchanged.

## Offline validation

`scripts/verify-responses-budget.py` runs against the installed wheel's real
Responses unit adapter, batching, result reconstruction, and compression
executors. Inference is replaced with a deterministic 25ms operation; the
whole-payload method is narrowed to the unit adapter. Network calls are blocked.
These are regression simulations, not ONNX or provider performance measurements.

With a 120ms shared budget and 500ms outer timeout, representative results were:

| Workload | Parallelism | Elapsed | Units compressed | Estimated tokens saved / before |
| --- | --- | --- | --- | --- |
| 100 large units | 1 | 133ms | 4 | 688 / 18,000 |
| 100 large units | 4 | 132ms | 16 | 2,752 / 18,000 |
| 1,000 small units batched by the adapter | 1 | 141ms | 25 | 425 / 25,000 |
| 1,000 small units batched by the adapter | 4 | 153ms | 97 | 1,649 / 25,000 |

The same four workloads with the fix disabled exceeded the outer timeout,
activated timeout debt, and continued compression afterward. With the fix,
all returned partial results with no remaining worker debt; untouched outputs
and call IDs were preserved. Fast output and estimated savings matched the
unbounded control. Cancellation, context isolation through both executor hops,
native nested deadline propagation, keyword arguments, and opt-outs passed.

All seven `behaves_against_the_installed_wheel` Rust checks passed, including
the transient reminder repair, cache observer, and sanctioned prefix-floor
vendor. The offline cache checks confirm stable historical replay; they cannot
measure actual provider cache reads. No Claude/Fable quota was used.

## Limits and rollout

A native inference already in progress cannot safely be interrupted. A single
hung native call can still time out and trigger the existing quarantine. The
fix prevents the observed chain of fresh inference calls from continuing for
minutes; it is not hard process isolation.

This is a source change, not an installed rc3 update. Before stable promotion,
run the required full staging day and fleet DiD gate in CLAUDE.md. Check both
absolute provider cache reads and cache reads / forwarded input, plus tokens
saved / original tokens for large requests. Offline tests do not replace that
production validation.
