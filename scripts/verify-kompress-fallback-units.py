#!/usr/bin/env python3
"""Probe the Kompress fallback-units vendor (upstream #3881) against the INSTALLED wheel.

The wheel counts a code_aware result in WORDS and judges the Kompress fallback
in TOKENS, so a code_aware no-op on line-numbered code always discards a
smaller Kompress result. The vendor applies #3881's three hunks; these checks
are #3881's own three tests, run against the patched installed method.

Run with the desktop's sitecustomize on PYTHONPATH:

    PYTHONPATH=<pyinject> HEADROOM_SDK=headroom-desktop-proxy \
        <managed python> scripts/verify-kompress-fallback-units.py

Prints one `OK`/`FAIL` line per check. `FAIL kfu bound` specifically means the
vendor did not bind (wheel bumped, or kill switch set), which the caller
treats as a skip rather than a failure.
"""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace

os.environ.pop("HEADROOM_LOSSLESS_THEN_LOSSY", None)

import sitecustomize
from headroom.transforms.content_router import (
    CompressionStrategy,
    ContentRouter,
    ContentRouterConfig,
    _estimate_tokens,
)

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK   " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


bound = getattr(sitecustomize, "_hd_bound", set())
check("kompress_fallback_units" in bound, "kfu bound")
check("kompress_waste" not in bound, "kompress_waste stood down")

# A Claude Code Read of Rust: line-numbered code that code_aware hands back
# unchanged while reporting compressed=True. ~2 tokens per whitespace word.
NUMBERED_RUST = "\n".join(
    f"{i}\tlet value_{i} = compute(&items[{i}..], Some(opts.clone()))?;" for i in range(1, 121)
)


def noop_code_aware_router(kompress_out: str, calls: list[str] | None = None) -> ContentRouter:
    router = ContentRouter(ContentRouterConfig(enable_code_aware=True))

    class NoopCodeCompressor:
        def compress(self, content, language=None, context=""):
            return SimpleNamespace(compressed=content, compressed_tokens=0)

    router._get_code_compressor = lambda: NoopCodeCompressor()

    def kompress(content, *_args, **_kwargs):
        if calls is not None:
            calls.append(content)
        # What Kompress reports: payload tokens for a real compression, the
        # WORD count for a passthrough.
        if kompress_out == content:
            return content, len(content.split())
        return kompress_out, _estimate_tokens(kompress_out)

    router._try_ml_compressor = kompress
    return router


def run(router: ContentRouter):
    return router._apply_strategy_to_content(NUMBERED_RUST, CompressionStrategy.CODE_AWARE, context="")


# 1. A Kompress result smaller in tokens (but larger than the word count) wins.
kompressed = "\n".join(f"{i}\tvalue_{i} compute(&items[{i}..])" for i in range(1, 121))
assert _estimate_tokens(kompressed) < _estimate_tokens(NUMBERED_RUST)
assert _estimate_tokens(kompressed) > len(NUMBERED_RUST.split())
compressed, tokens, chain = run(noop_code_aware_router(kompressed))
check(
    compressed == kompressed
    and tokens == _estimate_tokens(kompressed)
    and chain == ["code_aware", "kompress"],
    f"code_aware no-op keeps a smaller Kompress fallback {chain}",
)

# 2. A passthrough is reported at its token count, never its word count.
compressed, tokens, _ = run(noop_code_aware_router(NUMBERED_RUST))
check(
    compressed == NUMBERED_RUST and tokens == _estimate_tokens(NUMBERED_RUST),
    f"passthrough reported in tokens ({tokens})",
)

# 3. Lossless-then-lossy tries Kompress inline; a losing attempt is not re-run.
calls: list[str] = []
router = noop_code_aware_router(NUMBERED_RUST, calls)
router._lossless_then_lossy = True
compressed, tokens, _ = run(router)
check(
    compressed == NUMBERED_RUST and tokens == _estimate_tokens(NUMBERED_RUST) and len(calls) == 1,
    f"inline passthrough runs Kompress once ({len(calls)} calls)",
)

sys.exit(1 if failures else 0)
