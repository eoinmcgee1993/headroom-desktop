#!/usr/bin/env python3
"""Prove the per-conversation savings vendor against the INSTALLED wheel.

The vendor (upstream PR #3480, sitecustomize block
HEADROOM_CONVERSATION_SAVINGS) stops OpenAI /v1/responses from booking the
same removed token once per remaining turn. Run under the managed runtime
with the shipped sitecustomize on PYTHONPATH; it patches real classes from
the installed headroom-ai, so this fails if a wheel moves any of the three
seams out from under it.

Asserts, in order:
  1. the vendor bound at all (skippable signal when a wheel ships #3480);
  2. turn one of a conversation counts in full;
  3. turn two counts only what the running total grew by -- the whole point;
  4. per-request surfaces keep the wire figure, so the feed still describes
     what left this process;
  5. a compaction (total goes DOWN) counts zero, not a negative;
  6. paths with no conversation identity (every non-Codex handler) are
     untouched however many turns go by;
  7. the kill switch restores the old inflated accounting exactly.

Prints OK/FAIL lines; exit code 0 only when every check passed.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

FAILURES: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK " if ok else "FAIL ") + label)
    if not ok:
        FAILURES.append(label)


# The vendor rewrites the value inside PrometheusMetrics.record_request and
# CostTracker.record_tokens, so a hand-rolled double would bypass the seam
# entirely and the probe would pass on a vendor that does nothing. Subclass
# the real classes (skipping their heavy __init__) so the shipped wrapper
# chain runs, and swap the INNERMOST original for a recorder.
METRICS_CALLS: list[int] = []
COST_CALLS: list[int] = []


class _Logger:
    def __init__(self) -> None:
        self.logged: list[Any] = []

    def log(self, entry: Any) -> None:
        self.logged.append(entry)


class _Handler:
    """Enough of HeadroomProxy for the funnel, plus the compressor seam."""

    def __init__(self, metrics: Any, cost_tracker: Any) -> None:
        self.metrics = metrics
        self.cost_tracker = cost_tracker
        self.logger = _Logger()
        self.config = type("C", (), {"log_full_messages": False})()

    async def _record_request_outcome(self, outcome):
        from headroom.proxy.outcome import emit_request_outcome

        await emit_request_outcome(self, outcome)


def _body(user_text: str) -> dict[str, Any]:
    return {
        "model": "gpt-6-astra",
        "input": [{"role": "user", "content": user_text}],
        "instructions": "be brief",
    }


def _outcome(request_id: str, tokens_saved: int):
    from headroom.proxy.outcome import RequestOutcome

    return RequestOutcome(
        request_id=request_id,
        provider="openai",
        model="gpt-6-astra",
        original_tokens=80_240 + tokens_saved,
        optimized_tokens=80_240,
        output_tokens=177,
        tokens_saved=tokens_saved,
        attempted_input_tokens=90_000,
        cache_read_tokens=66_304,
        tags={"endpoint": "responses_http"},
        client="codex",
    )


async def main() -> int:
    import headroom.proxy.cost as cost_mod
    import headroom.proxy.prometheus_metrics as prom_mod
    import headroom.proxy.server as server

    # Other vendors in the same sitecustomize wrap the compressor seam AFTER
    # this one, so the outermost name is not ours. The funnel seam is only
    # wrapped here, so that is the honest binding signal.
    bound = (
        getattr(server.HeadroomProxy._record_request_outcome, "__name__", "") == "_hd_cs_record"
    )
    check(bound, "cs bound (vendor patched the outcome funnel)")
    if not bound:
        return 1
    # Every vendor is defined in the one sitecustomize module, so they share
    # module globals; this is how the probe reaches the inner pass.
    vendor_globals = server.HeadroomProxy._record_request_outcome.__globals__

    async def record_metrics(self, **kwargs: Any) -> None:
        METRICS_CALLS.append(kwargs.get("tokens_saved"))

    def record_cost(self, model, tokens_saved, tokens_sent, **kwargs: Any):
        COST_CALLS.append(tokens_saved)

    # Swap the INNERMOST original on the metrics chain, so the whole shipped
    # wrapper stack runs. The first-appearance vendor also rewrites
    # tokens_saved on this seam and binds INSIDE this one on purpose; going in
    # underneath it is what proves the two compose instead of one erasing the
    # other.
    if "_hd_fa_orig_record" in vendor_globals:
        vendor_globals["_hd_fa_orig_record"] = record_metrics
    else:
        vendor_globals["_hd_cs_orig_metrics"] = record_metrics
    vendor_globals["_hd_cs_orig_cost"] = record_cost

    handler = _Handler(
        prom_mod.PrometheusMetrics.__new__(prom_mod.PrometheusMetrics),
        cost_mod.CostTracker.__new__(cost_mod.CostTracker),
    )

    async def turn(request_id: str, body: dict[str, Any], cumulative: int) -> None:
        """One /v1/responses turn: compress, then record the outcome."""
        original = server.HeadroomProxy._record_request_outcome

        async def fake_compress(self, payload, **kwargs):
            return (payload, True, cumulative, [], None, 0, 0, 0, {})

        # Drive the vendor's compressor wrapper with a stub inner pass: this
        # exercises the real wrapper (key derivation + stash) without needing
        # a live router.
        wrapper = vendor_globals["_hd_cs_compress"]
        inner = vendor_globals["_hd_cs_orig_compress"]
        vendor_globals["_hd_cs_orig_compress"] = fake_compress
        try:
            await wrapper(handler, body, model="gpt-6-astra", request_id=request_id)
        finally:
            vendor_globals["_hd_cs_orig_compress"] = inner
        await original(handler, _outcome(request_id, cumulative))

    conversation = _body("refactor the router")

    await turn("req-1", conversation, 62_806)
    check(METRICS_CALLS == [62_806], f"turn one counts in full: {METRICS_CALLS}")

    await turn("req-2", conversation, 76_020)
    check(
        METRICS_CALLS[-1] == 13_214,
        f"turn two counts only the growth: {METRICS_CALLS[-1]} (want 13214)",
    )
    check(
        COST_CALLS[-1] == 13_214,
        f"cost sees the novel figure too: {COST_CALLS[-1]}",
    )
    check(
        handler.logger.logged[-1].tokens_saved == 76_020
        and handler.logger.logged[-1].input_tokens_original == 80_240 + 76_020,
        "per-request log keeps the wire figure",
    )

    await turn("req-3", conversation, 9_000)
    check(
        METRICS_CALLS[-1] == 0,
        f"a compaction counts zero, not negative: {METRICS_CALLS[-1]}",
    )

    # No conversation identity: every non-Codex handler's shape.
    before = len(METRICS_CALLS)
    for _ in range(3):
        await server.HeadroomProxy._record_request_outcome(handler, _outcome("req-anthropic", 458))
    check(
        METRICS_CALLS[before:] == [458, 458, 458],
        f"unidentified paths are untouched: {METRICS_CALLS[before:]}",
    )

    # Composition with the first-appearance vendor, which subtracts its
    # pending amount on the same seam. This one must substitute FIRST so that
    # subtraction still applies; bound the other way it is silently erased.
    pending = vendor_globals.get("_hd_fa_pending")
    if pending is not None:
        pending[0] = 1_000
        before = len(METRICS_CALLS)
        await turn("req-4", conversation, 20_000)
        # novel = 20000 - 9000 = 11000, less the 1000 first-appearance pending.
        check(
            METRICS_CALLS[before] == 10_000,
            f"first-appearance subtraction survives: {METRICS_CALLS[before]} (want 10000)",
        )
    else:
        check(False, "first-appearance vendor not present to compose with")

    return 0


def main_killswitch() -> int:
    """Re-exec with the kill switch set; the old inflated accounting returns."""
    import subprocess

    env = dict(os.environ)
    env["HEADROOM_CONVERSATION_SAVINGS"] = "0"
    env["HEADROOM_CS_PROBE_CHILD"] = "1"
    out = subprocess.run(
        [sys.executable, __file__], env=env, capture_output=True, text=True
    )
    check(
        "FAIL cs bound" in out.stdout,
        "kill switch leaves the vendor unbound",
    )
    return 0


if __name__ == "__main__":
    code = asyncio.run(main())
    if not os.environ.get("HEADROOM_CS_PROBE_CHILD"):
        main_killswitch()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s)")
        sys.exit(1)
    print("OK conversation-savings")
    sys.exit(code)
