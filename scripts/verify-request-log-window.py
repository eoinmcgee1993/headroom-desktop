#!/usr/bin/env python3
"""Functional probe for the request-log body window vendor.

Run with the managed venv's python and PYTHONPATH pointing at a directory holding
the desktop's sitecustomize.py:

  1. bind: the vendor wrapped RequestLogger.log on the 0.38.0 pin. Not bound ->
     'FAIL rlw bound', exit 0 (Rust test self-skips: a wheel that ships
     MESSAGE_WINDOW leaves the vendor inert by design).
  2. after WINDOW+50 logged entries every entry is still present (light fields
     intact, in order) but only the newest WINDOW keep request_messages /
     compressed_messages / response_content.
  3. the feed path (get_recent_with_messages(WINDOW)) is fully populated.
  4. HEADROOM_REQUEST_LOG_WINDOW=0 really unbinds (fresh interpreter).
"""

from __future__ import annotations

import os
import subprocess
import sys

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


def main() -> int:
    import sitecustomize as sc

    from headroom.proxy.models import RequestLog
    from headroom.proxy.request_logger import RequestLogger

    if RequestLogger.log.__name__ != "_hd_rlw_log":
        print("FAIL rlw bound")
        return 0
    window = sc._hd_rlw_WINDOW

    def entry(i: int) -> RequestLog:
        return RequestLog(
            request_id=f"r{i}",
            timestamp="2026-09-22T00:00:00Z",
            provider="anthropic",
            model="claude-sonnet-5",
            input_tokens_original=100,
            input_tokens_optimized=40,
            output_tokens=1,
            tokens_saved=60,
            savings_percent=60.0,
            optimization_latency_ms=1.0,
            total_latency_ms=None,
            tags={},
            cache_hit=False,
            transforms_applied=["kompress:user:0.4"],
            request_messages=[{"role": "user", "content": f"pre{i}"}],
            compressed_messages=[{"role": "user", "content": f"post{i}"}],
            response_content=f"resp{i}",
        )

    lg = RequestLogger(log_file=None, log_full_messages=True)
    n = window + 50
    for i in range(n):
        lg.log(entry(i))
    logs = list(lg._logs)
    check(len(logs) == n, "every entry retained")
    check(
        all(e.request_id == f"r{i}" and e.tokens_saved == 60 for i, e in enumerate(logs)),
        "light fields untouched and in order",
    )

    def bare(e: RequestLog) -> bool:
        return e.request_messages is None and e.compressed_messages is None and e.response_content is None

    check(all(bare(e) for e in logs[:-window]), "bodies nulled beyond the window")
    check(not any(bare(e) for e in logs[-window:]), "bodies kept inside the window")
    feed = lg.get_recent_with_messages(window)
    check(
        len(feed) == window and all(item["request_messages"] for item in feed),
        "feed window fully populated",
    )

    env = dict(os.environ, HEADROOM_REQUEST_LOG_WINDOW="0")
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "from headroom.proxy.request_logger import RequestLogger; print(RequestLogger.log.__name__)",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    check(out.stdout.strip() == "log", "kill switch unbinds")

    if failures:
        return 1
    print("OK request-log window: bodies bounded to the feed window, light fields intact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
