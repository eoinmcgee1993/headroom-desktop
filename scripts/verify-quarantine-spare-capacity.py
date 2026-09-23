#!/usr/bin/env python3
"""Probe the quarantine spare-capacity vendor against the INSTALLED wheel.

The wheel refuses ALL compression while any timed-out worker is still running.
The vendor stands that quarantine down while fewer than half the pool's
workers are stuck, and leaves it armed from half the pool up.

Run with the desktop's sitecustomize on PYTHONPATH:

    PYTHONPATH=<pyinject> <managed python> scripts/verify-quarantine-spare-capacity.py

Prints one `OK`/`FAIL` line per check. `FAIL cq bound` specifically means the
vendor did not bind (wheel bumped, or kill switch set), which the caller
treats as a skip rather than a failure.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import threading
import time
from types import SimpleNamespace

from headroom.proxy import server

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK   " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


run = server.HeadroomProxy._run_compression_in_executor
check(run.__name__ == "_hd_cq_run", "cq bound")


def proxy(workers: int) -> server.HeadroomProxy:
    # Only the attributes _run_compression_in_executor touches; the real
    # constructor boots the whole proxy.
    p = object.__new__(server.HeadroomProxy)
    p.compression_max_workers = workers
    p._compression_executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    p._compression_metrics_lock = threading.Lock()
    p.metrics = SimpleNamespace(record_compression_quarantine=lambda _outcome: None)
    p._compression_quarantine_max_seconds = 60.0
    p._compression_quarantine_deadline = 0.0
    for name in (
        "_compression_queued",
        "_compression_queued_max",
        "_compression_queue_timeouts",
        "_compression_queue_wait_seconds_total",
        "_compression_queue_wait_seconds_max",
        "_compression_in_flight",
        "_compression_in_flight_max",
        "_compression_run_seconds_total",
        "_compression_run_seconds_max",
        "_compression_leaked_threads",
        "_compression_timed_out_in_flight",
        "_compression_timed_out_in_flight_max",
        "_compression_quarantine_activations",
        "_compression_quarantine_skips",
        "_compression_quarantine_releases",
    ):
        setattr(p, name, 0)
    return p


async def strand(p: server.HeadroomProxy, release: threading.Event) -> None:
    """Leave one worker running past its timeout: one unit of timeout debt."""
    try:
        await p._run_compression_in_executor(release.wait, timeout=0.05)
    except asyncio.TimeoutError:
        pass


async def refused(p: server.HeadroomProxy) -> bool:
    try:
        await p._run_compression_in_executor(lambda: None, timeout=5)
        return False
    except server.CompressionQuarantinedError:
        return True


async def main() -> None:
    release = threading.Event()

    # 8 workers: one straggler must not refuse the next request.
    p = proxy(8)
    await strand(p, release)
    check(p._compression_timed_out_in_flight == 1, "one worker stranded")
    check(not await refused(p), "1 of 8 stuck: compression still runs")
    check(p._compression_quarantine_skips == 0, "no skip counted")
    check(p._compression_quarantine_releases == 0, "no spurious release")
    for _ in range(3):
        await strand(p, release)
    check(p._compression_timed_out_in_flight == 4, "four workers stranded")
    check(await refused(p), "4 of 8 stuck: quarantine re-armed")

    # 2 workers: half rounds down to 1, so today's behaviour is kept.
    small = proxy(2)
    await strand(small, release)
    check(await refused(small), "1 of 2 stuck: quarantine as before")

    release.set()
    time.sleep(0.1)


asyncio.run(main())
sys.exit(1 if failures else 0)
