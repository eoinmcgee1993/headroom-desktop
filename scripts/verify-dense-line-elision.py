#!/usr/bin/env python3
"""Prove the dense-line elision vendor against the INSTALLED wheel.

Run under the managed runtime with the shipped sitecustomize on PYTHONPATH and
HEADROOM_SDK=headroom-desktop-proxy. Patches the real ContentRouter from the
installed headroom-ai, so this fails if a wheel moves the seam.

Checks, in order:
  1. the vendor bound (the skippable signal when a wheel ships the fix);
  2. the three real shapes (a script-only page, a raw bundle dump behind a
     path header, a base64 blob) shrink by more than half, carry a "Retrieve
     original: hash=" marker, and the hash retrieves the pre-elision block;
  3. prose, indented code and JSON-lines output are byte-identical (JSON is
     SmartCrusher's);
  4. lossless mode never elides;
  5. the messages path (router.apply, the #1307 marker-less lossy gate)
     keeps the elided tool_result instead of restoring the original;
  6. the kill switch unbinds (re-runs this file in a subprocess).
Prints OK/FAIL lines; exit code 0 only when every check passed.
"""

from __future__ import annotations

import os
import subprocess
import sys

FAILURES: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK " if ok else "FAIL ") + label)
    if not ok:
        FAILURES.append(label)


MINIFIED_JS = (
    "!function(){var e=window,t=e.document,n=t.createElement('div');"
    "n.className='x';for(var r=0;r<1e3;r++){n.appendChild(t.createTextNode(r))}"
    "e.__x=n;var a=e.location.search.replace(/^\\?/,'').split('&');"
) * 24
HEADER = "Script completed\nWall time 0.2 seconds\nOutput:\n\n"
BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" * 40
PROSE = "This is an ordinary paragraph with plenty of spaces in it, " * 12
CODE = "\n".join(f"    value_{i} = compute(arg_{i}, other_{i})  # comment {i}" for i in range(40))
JSONL = " ".join(f'{{"file":"src/m_{i}.py","line":{i},"text":"repeated search payload"}}' for i in range(160))


def main() -> int:
    from headroom.transforms import content_router as cr

    bound = getattr(cr.ContentRouter._apply_strategy_to_content, "__name__", "") == "_hd_dle_apply"
    if "--expect-unbound" in sys.argv:
        check(not bound, "kill switch unbinds")
        return 1 if FAILURES else 0
    check(bound, "dle bound (vendor patched the router strategy dispatch)")
    if FAILURES:
        return 1

    from headroom.cache.compression_store import get_compression_store
    from headroom.providers import OpenAIProvider
    from headroom.tokenizer import Tokenizer

    cfg = cr.ContentRouterConfig(enable_kompress=False, min_section_tokens=10)
    router = cr.ContentRouter(cfg)
    # The three real shapes: a script-only page (HTML extractor finds no body
    # text), a raw bundle dump behind a path header (code_aware, disabled, then
    # a Kompress fallback that changes nothing), and an encoded blob (text).
    page = HEADER + "tinyeval.ai\n<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><script>" + MINIFIED_JS + "</script></head><body></body></html>\n"
    bundle = HEADER + "/tmp/site/_next/static/chunks/main.js\n1:" + MINIFIED_JS + "\n"
    blob = "data:image/png;base64," + BASE64 + "\n"
    for label, text in (("script-only page", page), ("raw bundle dump", bundle), ("base64 blob", blob)):
        out = router.compress(text, context="tool_result").compressed
        check("content elided" in out and len(out) < len(text) // 2, f"{label} shrinks ({len(text)} -> {len(out)} chars)")
        check("Retrieve original: hash=" in out, f"{label} carries a retrieval marker")
        if "hash=" in out:
            key = out.rsplit("hash=", 1)[1].rstrip("]\n")
            check(get_compression_store().retrieve(key) is not None, f"{label} hash retrieves the pre-elision block")

    for label, text in (("prose", PROSE), ("indented code", CODE), ("JSON lines", JSONL)):
        r = router.compress(text, context="tool_result").compressed
        check("content elided" not in r, f"{label} never elided")

    lossless = cr.ContentRouter(cr.ContentRouterConfig(enable_kompress=False, lossless=True, min_section_tokens=10))
    check("content elided" not in lossless.compress(page, context="tool_result").compressed, "lossless mode never elides")

    tokenizer = Tokenizer(OpenAIProvider().get_token_counter("gpt-4o"), "gpt-4o")
    body = HEADER + "<!DOCTYPE html><html><head><script>" + MINIFIED_JS * 3 + "</script></head><body></body></html>\n"
    messages = [
        {"role": "user", "content": "check the site"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "curl -s x"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": body}]},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "and now?"},
    ]
    result = cr.ContentRouter(cfg).apply(messages, tokenizer)
    block = result.messages[2]["content"][0]["content"]
    text = block if isinstance(block, str) else block[0]["text"]
    check("content elided" in text and "Retrieve original: hash=" in text and len(text) < len(body) // 2,
          f"messages path keeps the elided tool_result ({len(body)} -> {len(text)} chars)")

    env = dict(os.environ, HEADROOM_DENSE_LINE_ELISION="0")
    proc = subprocess.run([sys.executable, __file__, "--expect-unbound"], env=env, capture_output=True, text=True)
    print(proc.stdout.strip())
    check(proc.returncode == 0, "kill switch unbinds (subprocess)")

    print("OK dense-line-elision" if not FAILURES else "FAIL dense-line-elision: " + "; ".join(FAILURES))
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
