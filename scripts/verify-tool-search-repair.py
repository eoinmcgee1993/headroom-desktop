#!/usr/bin/env python3
"""Functional probe for the tool-search deferred-availability repair vendor.

Run with the managed venv's python and PYTHONPATH pointing at a directory
holding the desktop's sitecustomize.py. Verifies, against the INSTALLED wheel,
that strip_unsupported_tool_search_blocks treats a defer_loading=true tool as
NOT available for resolving a historical tool_reference:

  1. bind: the wrapper installed on the 0.37.0 pin. When it did not bind (wheel
     bumped past the pin, or the kill switch is set) prints 'FAIL tsr bound' and
     exits 0 -- the Rust test treats that as self-skip, because a wheel that
     ships the fix upstream leaves this vendor inert by design.
  2. deferred: a tool_search_tool_result referencing a still-deferred tool is
     DROPPED (removed > 0). Pre-fix this block was kept and Anthropic 400'd
     ("Tool reference 'CronCreate' not found in available tools").
  3. loaded: the same reference against a NON-deferred tool is KEPT (removed 0).
  4. absent: with no tool_search_tool_* present, the block is DROPPED.
  5. isolation: a control subprocess with HEADROOM_TOOL_SEARCH_DEFER_REPAIR=0
     KEEPS the deferred block (reproduces the bug) and keeps the loaded one, so
     the vendor changes ONLY the deferred case and nothing else.
"""

import os
import subprocess
import sys

_SEARCH_TOOL = {"type": "tool_search_tool_regex", "name": "tool_search_tool_regex"}


def transcript():
    return [
        {"role": "user", "content": "set up a cron job"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "server_tool_use",
                    "id": "srv_1",
                    "name": "tool_search_tool_regex",
                    "input": {"query": "cron"},
                },
                {
                    "type": "tool_search_tool_result",
                    "tool_use_id": "srv_1",
                    "content": {
                        "tool_references": [
                            {"type": "tool_reference", "tool_name": "CronCreate"}
                        ]
                    },
                },
            ],
        },
    ]


def removed_for(strip, tools):
    _, removed = strip([dict(m) for m in transcript()], tools)
    return removed


def main() -> int:
    import sitecustomize as sc  # noqa: F401  (auto-imported anyway)
    from headroom.proxy import helpers

    strip = helpers.strip_unsupported_tool_search_blocks
    vendor_on = hasattr(sc, "_hd_tsr_orig")

    if os.environ.get("HEADROOM_TOOL_SEARCH_DEFER_REPAIR") == "0":
        # Control run (kill switch): the vendor must NOT be bound, and the
        # deferred block must be KEPT -- this is the pre-fix 400 behavior.
        if vendor_on:
            print("FAIL kill switch did not disable the vendor")
            return 1
        deferred = removed_for(strip, [_SEARCH_TOOL, {"name": "CronCreate", "defer_loading": True}, {"name": "Bash"}])
        loaded = removed_for(strip, [_SEARCH_TOOL, {"name": "CronCreate"}, {"name": "Bash"}])
        if deferred != 0:
            print("FAIL control expected deferred kept, got removed:", deferred)
            return 1
        if loaded != 0:
            print("FAIL control expected loaded kept, got removed:", loaded)
            return 1
        print("OK control: deferred kept (pre-fix), loaded kept")
        return 0

    if not vendor_on:
        print("FAIL tsr bound")
        return 0

    deferred = removed_for(strip, [_SEARCH_TOOL, {"name": "CronCreate", "defer_loading": True}, {"name": "Bash"}])
    loaded = removed_for(strip, [_SEARCH_TOOL, {"name": "CronCreate"}, {"name": "Bash"}])
    absent = removed_for(strip, [{"name": "CronCreate"}])

    if deferred <= 0:
        print("FAIL deferred reference not dropped (the 400 bug), removed:", deferred)
        return 1
    if loaded != 0:
        print("FAIL loaded reference wrongly dropped, removed:", loaded)
        return 1
    if absent <= 0:
        print("FAIL absent-search-tool reference not dropped, removed:", absent)
        return 1

    # Isolation: with the kill switch set, the deferred block is kept again.
    env = dict(os.environ)
    env["HEADROOM_TOOL_SEARCH_DEFER_REPAIR"] = "0"
    control = subprocess.run(
        [sys.executable, os.path.abspath(__file__)],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if control.returncode != 0 or "OK control" not in control.stdout:
        print("FAIL kill-switch control run:", control.stdout.strip(), control.stderr[-300:])
        return 1

    print("OK tool-search repair: deferred dropped, loaded kept, absent dropped, kill switch reverts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
