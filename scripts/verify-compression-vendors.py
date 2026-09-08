#!/usr/bin/env python3
"""Prove the three compression vendors against the INSTALLED wheel.

Run under the managed runtime with the shipped sitecustomize on PYTHONPATH and
HEADROOM_SDK=headroom-desktop-proxy. Patches real classes from the installed
headroom-ai, so this fails if a wheel moves a seam out from under a vendor.

Checks, in order:
  1. each vendor bound (the skippable signal when a wheel ships the fix);
  2. thinking signatures: a signed thinking block counts the same as an
     unsigned one, on the base walker and on the Anthropic provider counter;
  3. fresh cache_control: a final-message tool_result carrying cache_control
     is compressed and keeps its marker, the client's original block is not
     mutated, an earlier message's block stays protected and counted, and an
     assistant block in the final position keeps the hard skip;
  4. Kompress marker gate: a 20 percent shrink (ratio 0.80, unmarked by the
     wheel's `< 0.8` gate) gets stored and marked on both compress paths, a
     shrink smaller than the marker stays unmarked, and a passthrough is
     untouched;
  5. the three kill switches unbind (re-runs this file in a subprocess).

Prints OK/FAIL lines; exit code 0 only when every check passed.
"""

from __future__ import annotations

import os
import subprocess
import sys
from types import SimpleNamespace
from typing import Any

FAILURES: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK " if ok else "FAIL ") + label)
    if not ok:
        FAILURES.append(label)


class _Enc(dict):
    def word_ids(self, batch_index: int = 0):
        return self["_word_ids"][batch_index]


class _Tok:
    def __call__(self, chunk_words: Any, **kw: Any) -> _Enc:
        batch = chunk_words if chunk_words and isinstance(chunk_words[0], list) else [chunk_words]
        return _Enc(
            input_ids=[[0] * len(w) for w in batch],
            attention_mask=[[1] * len(w) for w in batch],
            _word_ids=[list(range(len(w))) for w in batch],
        )


class _DropFirst:
    """Keep every word except the first ``drop`` of each row."""

    def __init__(self, drop: int) -> None:
        self.drop = drop

    def get_keep_mask(self, input_ids: Any, attention_mask: Any) -> Any:
        return [[i >= self.drop for i, _ in enumerate(row)] for row in input_ids]

    def get_scores(self, input_ids: Any, attention_mask: Any) -> Any:
        return [[0.0 if i < self.drop else 1.0 for i, _ in enumerate(row)] for row in input_ids]


def _prose(n: int) -> str:
    # Plain lowercase words: nothing the must-keep override would pin.
    return " ".join(f"w{chr(97 + i % 26)}{chr(97 + (i // 26) % 26)}" for i in range(n))


def main() -> int:
    from headroom.tokenizers import base as tb
    from headroom.transforms import content_router as cr
    from headroom.transforms import kompress_compressor as kc

    sig_bound = getattr(tb.BaseTokenizer._count_content_parts, "__name__", "") == "_hd_sig_count"
    fcc_bound = (
        getattr(cr.ContentRouter._process_content_blocks, "__name__", "") == "_hd_fcc_process"
    )
    kmg_bound = getattr(kc.KompressCompressor.compress, "__name__", "") == "_hd_kmg_compress"
    if "--expect-unbound" in sys.argv:
        check(not (sig_bound or fcc_bound or kmg_bound), "kill switches unbind all three")
        return 1 if FAILURES else 0
    check(sig_bound, "sig bound (vendor patched the block walker)")
    check(fcc_bound, "fcc bound (vendor patched the router block processor)")
    check(kmg_bound, "kmg bound (vendor patched Kompress.compress)")
    if FAILURES:
        return 1

    # 2. thinking signatures ---------------------------------------------------
    from headroom.providers.anthropic import AnthropicProvider
    from headroom.tokenizers import EstimatingTokenCounter

    text = "consider the failing test " * 20
    signed = [
        {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": text, "signature": "A" * 4000}],
        }
    ]
    unsigned = [{"role": "assistant", "content": [{"type": "thinking", "thinking": text}]}]
    empty = [{"role": "assistant", "content": [{"type": "thinking", "thinking": ""}]}]
    est = EstimatingTokenCounter()
    a, b, c = est.count_messages(signed), est.count_messages(unsigned), est.count_messages(empty)
    check(a == b, f"base walker: signed == unsigned ({a} == {b})")
    check(a > c, f"base walker: thinking text still priced ({a} > {c})")
    ant = AnthropicProvider().get_token_counter("claude-opus-5")
    a2, b2 = ant.count_messages(signed), ant.count_messages(unsigned)
    check(a2 == b2, f"anthropic counter: signed == unsigned ({a2} == {b2})")

    # 3. fresh cache_control ---------------------------------------------------
    router = cr.ContentRouter(cr.ContentRouterConfig())

    def fake_compress(content, context="", bias=1.0, precomputed_detection=None):
        return SimpleNamespace(
            compressed=content[: len(content) // 2] + "[compressed]",
            compression_ratio=0.5,
            strategy_used=cr.CompressionStrategy.LOG,
        )

    router.compress = fake_compress  # type: ignore[method-assign]
    long_text = "Z" * 1000

    def msg(role: str = "user") -> dict[str, Any]:
        return {
            "role": role,
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "abc",
                    "content": long_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }

    fresh = msg()
    counts: dict[str, int] = {}
    out = router._process_content_blocks(
        fresh, fresh["content"], "", [], set(), set(), route_counts=counts, messages_from_end=1
    )
    blk = out["content"][0]
    check(str(blk.get("content", "")).endswith("[compressed]"), "final-message cache_control tool_result compressed")
    check(blk.get("cache_control") == {"type": "ephemeral"}, "marker rides on the compressed block")
    check(
        fresh["content"][0]["content"] == long_text and "cache_control" in fresh["content"][0],
        "client's original block not mutated",
    )
    check("cache_control_protected" not in counts, "fresh block not counted as protected")
    older = msg()
    counts_older: dict[str, int] = {}
    out_older = router._process_content_blocks(
        older, older["content"], "", [], set(), set(), route_counts=counts_older, messages_from_end=3
    )
    check(
        out_older["content"][0]["content"] == long_text
        and counts_older.get("cache_control_protected") == 1,
        "earlier message's cache_control block stays protected",
    )
    amsg = {
        "role": "assistant",
        "content": [{"type": "text", "text": long_text, "cache_control": {"type": "ephemeral"}}],
    }
    out_a = router._process_content_blocks(
        amsg, amsg["content"], "", [], set(), set(), messages_from_end=1, compress_assistant_text_blocks=True
    )
    check(out_a["content"][0]["text"] == long_text, "assistant final block keeps the hard skip")

    # 4. Kompress marker gate --------------------------------------------------
    saved_load, saved_dev = kc._load_kompress, kc._model_device_type
    try:

        def compressor(drop: int) -> Any:
            kc._load_kompress = lambda *a, **k: (_DropFirst(drop), _Tok(), "onnx")
            kc._model_device_type = lambda *a, **k: "cpu"
            comp = kc.KompressCompressor(kc.KompressConfig(min_input_words=10))
            comp._should_batch_single_content = lambda *a, **k: False
            comp._should_use_sequential_fallback = lambda: False
            comp._store_in_ccr = lambda *a, **k: "abc123"
            return comp

        r = compressor(20).compress(_prose(100))
        check(r.compressed_tokens == 80, f"kompress fake shrank 100 -> {r.compressed_tokens}")
        check(
            r.cache_key == "abc123" and "Retrieve more: hash=abc123" in r.compressed,
            "20 percent shrink gets a retrieval marker",
        )
        [rb] = compressor(20).compress_batch([_prose(100)], batch_size=8)
        check("Retrieve more: hash=abc123" in rb.compressed, "batch path marks too")
        r5 = compressor(5).compress(_prose(100))
        check(
            r5.cache_key is None and "Retrieve more" not in r5.compressed,
            "saving smaller than the marker stays unmarked",
        )
        r0 = compressor(0).compress(_prose(100))
        check(r0.compressed.split() == _prose(100).split(), "passthrough untouched")
    finally:
        kc._load_kompress, kc._model_device_type = saved_load, saved_dev

    # 5. kill switches ---------------------------------------------------------
    env = dict(
        os.environ,
        HEADROOM_THINKING_SIG_TOKENS="0",
        HEADROOM_FRESH_CC_COMPRESS="0",
        HEADROOM_KOMPRESS_MARKER_GATE="0",
    )
    proc = subprocess.run(
        [sys.executable, __file__, "--expect-unbound"], env=env, capture_output=True, text=True
    )
    print(proc.stdout.strip())
    check(proc.returncode == 0, "kill switches unbind (subprocess)")

    print("OK compression-vendors" if not FAILURES else "FAIL compression-vendors: " + "; ".join(FAILURES))
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
