#!/usr/bin/env python3
"""Functional probe for the first-appearance maturation accounting vendor.

Run with the managed venv's python and PYTHONPATH pointing at a directory
holding the desktop's sitecustomize.py. Verifies, against the INSTALLED
wheel:

  1. bind: the wrappers installed on the 0.37.0 pin. When they did not bind
     (wheel bumped past the pin, or the kill switch is set), prints
     'FAIL fa bound' and exits 0 -- the Rust test treats that as self-skip,
     because a wheel that ships first-appearance counting upstream leaves
     this vendor inert by design.
  2. traffic neutrality: the transformed messages of a mature-then-replay
     two-request sequence are byte-identical to a control subprocess running
     with HEADROOM_MATURATION_FIRST_APPEARANCE=0. The vendor must only
     observe the transform, never change what is forwarded.
  3. accounting: the newly-matured request accumulates nothing; the replay
     request accumulates a positive token delta; the record_request wrapper
     subtracts it from tokens_saved exactly once and drains, so the next
     request passes through untouched.
"""

import json
import os
import subprocess
import sys


def build_messages():
    # ~12KB tool_result so it clears any plausible min_size threshold.
    big = "def f(n):\n    return n * 2\n" * 480
    return [
        {"role": "user", "content": "read the file"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "reading"},
                {
                    "type": "tool_use",
                    "id": "tc_1",
                    "name": "Read",
                    "input": {"file_path": "/tmp/f.py"},
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tc_1", "content": big},
            ],
        },
        {"role": "assistant", "content": [{"type": "text", "text": "quiet 1"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "quiet 2"}]},
    ]


def run_transform():
    import sitecustomize  # noqa: F401  (auto-imported anyway; explicit for clarity)
    from headroom.transforms import read_maturation as rm

    try:
        cfg = rm.ReadMaturationConfig(enabled=True, quiesce_turns=1, min_size_bytes=64)
    except TypeError:
        cfg = rm.ReadMaturationConfig()
        for key, value in (("enabled", True), ("quiesce_turns", 1), ("min_size_bytes", 64)):
            try:
                setattr(cfg, key, value)
            except Exception:
                pass
    mgr = rm.ReadMaturationManager(cfg, compression_store=None)
    msgs = build_messages()
    # Request 1: the Read has been quiet for 2 assistant turns -> matures.
    r1 = mgr.apply([dict(m) for m in msgs])
    # Request 2: the client re-sends the raw conversation -> replay branch.
    r2 = mgr.apply([dict(m) for m in msgs])
    return r1, r2


def main() -> int:
    if os.environ.get("HD_FA_PROBE_MODE") == "control":
        r1, r2 = run_transform()
        print(json.dumps({"r1": r1.messages, "r2": r2.messages}, sort_keys=True))
        return 0

    import sitecustomize as sc

    if not hasattr(sc, "_hd_fa_pending"):
        print("FAIL fa bound")
        return 0

    from headroom.proxy import prometheus_metrics as pm

    r1, r2 = run_transform()
    marker_seen = json.dumps(r2.messages)
    if "Retrieve original: hash=" not in marker_seen:
        print("FAIL maturation did not run (no marker in replay output)")
        return 1

    delta = sc._hd_fa_pending[0]
    if delta <= 0:
        print("FAIL replay delta not accumulated")
        return 1
    # Exactly ONE replay's worth: request 1 (newly matured) must have
    # contributed nothing.
    if delta != sc._hd_fa_deltas.get("tc_1"):
        print("FAIL newly-matured request contributed to pending:", delta)
        return 1

    # 2. Traffic neutrality against an unpatched control run.
    env = dict(os.environ)
    env["HEADROOM_MATURATION_FIRST_APPEARANCE"] = "0"
    env["HD_FA_PROBE_MODE"] = "control"
    control = subprocess.run(
        [sys.executable, os.path.abspath(__file__)],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if control.returncode != 0:
        print("FAIL control run errored:", control.stderr[-400:])
        return 1
    ours = json.dumps({"r1": r1.messages, "r2": r2.messages}, sort_keys=True)
    if ours != control.stdout.strip():
        print("FAIL transformed messages differ from unpatched control")
        return 1

    # 3. The record seam subtracts once and drains.
    captured = {}

    async def fake_orig(self, *args, **kwargs):
        captured.clear()
        captured.update(kwargs)

    import asyncio

    class Stub:
        pass

    real = sc._hd_fa_orig_record
    sc._hd_fa_orig_record = fake_orig
    try:
        asyncio.run(
            pm.PrometheusMetrics.record_request(
                Stub(),
                provider="anthropic",
                model="probe",
                input_tokens=10,
                output_tokens=1,
                tokens_saved=delta + 250,
                latency_ms=1.0,
            )
        )
        if captured.get("tokens_saved") != 250:
            print("FAIL subtraction:", captured.get("tokens_saved"), "delta", delta)
            return 1
        if sc._hd_fa_pending[0] != 0:
            print("FAIL pending not drained:", sc._hd_fa_pending[0])
            return 1
        asyncio.run(
            pm.PrometheusMetrics.record_request(
                Stub(),
                provider="anthropic",
                model="probe",
                input_tokens=10,
                output_tokens=1,
                tokens_saved=500,
                latency_ms=1.0,
            )
        )
        if captured.get("tokens_saved") != 500:
            print("FAIL drain:", captured.get("tokens_saved"))
            return 1
    finally:
        sc._hd_fa_orig_record = real

    print("OK first-appearance accounting: bind, neutrality, subtract-once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
