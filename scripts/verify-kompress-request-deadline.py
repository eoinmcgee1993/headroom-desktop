#!/usr/bin/env python3
"""Probe the kompress request-deadline vendor against the INSTALLED wheel.

The vendor (upstream PR #3693) makes every kompress call of one request draw
down a single ``HEADROOM_COMPRESSION_DEADLINE_MS`` budget. Without it each
``compress()`` starts its own clock, so a request with N compressible blocks
gets N full budgets, overruns the pipeline's 30s compression timeout, and
opens the timeout-debt quarantine that forwards every request behind it with
no compression at all.

Run with the desktop's sitecustomize on PYTHONPATH:

    PYTHONPATH=<pyinject> <managed python> scripts/verify-kompress-request-deadline.py

Prints one `OK`/`FAIL` line per check. `FAIL krd bound` specifically means the
vendor did not bind (wheel bumped, or the wheel now ships the fix), which the
caller treats as a skip rather than a failure.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

from headroom.transforms import content_router as cr
from headroom.transforms import kompress_compressor as kc

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK   " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


bound = cr.ContentRouter.apply.__name__ == "_hd_krd_apply"
check(bound, "krd bound")
if not bound:
    # The caller reads this exact line to decide "skip", not "fail".
    sys.exit(1)


class OriginReader:
    """Stands in for the compressor, reading the origin the vendor exposes.

    The vendor injects ``_deadline_started_at`` by wrapping
    ``KompressCompressor.compress``, so a duck-typed stand-in never sees the
    kwarg -- and a real compressor cannot be intercepted below the wrapper.
    What this reads instead is the half that actually breaks on a wheel bump:
    whether the request origin is LIVE at the moment the router invokes
    kompress, on whatever thread the Pass 2 fan-out used.
    """

    def __init__(self) -> None:
        self.origins: list[float | None] = []

    def is_ready(self) -> bool:
        return True

    def ensure_background_load(self) -> None:  # pragma: no cover - never reached
        pass

    def compress(self, content, **kwargs):
        self.origins.append(kc._headroom_request_deadline_origin.get())
        compressed = " ".join(content.split()[:20])
        return SimpleNamespace(compressed=compressed, compressed_tokens=len(compressed.split()))


def messages(salt: str) -> list[dict]:
    """Two tool results, each big enough to reach the kompress stage."""
    return [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": f"toolu_{salt}_{n}",
                    "content": " ".join(
                        f'{{"file":"src/mod_{i}.py","line":{i},"text":"payload {salt}{n}"}}'
                        for i in range(160)
                    ),
                }
                for n in range(2)
            ],
        }
    ]


def tokenizer():
    from headroom.providers import OpenAIProvider
    from headroom.tokenizer import Tokenizer

    provider = OpenAIProvider()
    return Tokenizer(provider.get_token_counter("gpt-4o"), "gpt-4o")


check(
    hasattr(kc, "_headroom_request_deadline_origin"),
    "vendor exposes the request origin",
)
check(
    kc.KompressCompressor.compress.__name__ == "_hd_krd_compress",
    "compress() is the vendor's wrapper",
)
check(
    kc.KompressCompressor.compress_batch.__name__ == "_hd_krd_batch",
    "compress_batch() is the vendor's wrapper",
)

router = cr.ContentRouter()
rec = OriginReader()
router._get_kompress = lambda: rec  # type: ignore[method-assign]
tok = tokenizer()

check(
    kc._headroom_request_deadline_origin.get() is None,
    "no origin outside a request",
)

router.apply(messages("a"), tok, force_kompress=True)
check(len(rec.origins) >= 2, f"both blocks reached kompress ({len(rec.origins)})")
check(all(o is not None for o in rec.origins), "every block sees a live origin")
check(len(set(rec.origins)) == 1, f"one origin for the request ({sorted(set(rec.origins))})")
check(
    kc._headroom_request_deadline_origin.get() is None,
    "origin is cleared when the request ends",
)

first = set(rec.origins)
router.apply(messages("b"), tok, force_kompress=True)
fresh = set(rec.origins) - first
check(len(fresh) == 1, f"the next request gets a fresh origin ({sorted(fresh)})")

print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
