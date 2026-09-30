#!/usr/bin/env python3
"""Probe the token-mode read-window vendor against the INSTALLED wheel.

The desktop runs HEADROOM_MODE=token with the coding persona, whose
protect_recent=0 reaches ContentRouter.apply as read_protection_window=0 and
leaves a Claude Code Read unprotected at every position. The vendor restores
token mode's own window: a recent Read stays excluded (byte-exact), an aged one
still compresses.

Run with the desktop's sitecustomize on PYTHONPATH:

    PYTHONPATH=<pyinject> HEADROOM_SDK=headroom-desktop-proxy \
        <managed python> scripts/verify-token-read-window.py

Prints one `OK`/`FAIL` line per check. `FAIL trw bound` specifically means the
vendor did not bind (wheel bumped, or kill switch set), which the caller
treats as a skip rather than a failure.
"""

from __future__ import annotations

import logging
import os
import sys

logging.disable(logging.CRITICAL)
os.environ["HEADROOM_MODE"] = "token"
os.environ["HEADROOM_SAVINGS_PROFILE"] = "coding"
# Routing is what is under test; Kompress would only add seconds of inference.
os.environ["HEADROOM_DISABLE_KOMPRESS"] = "1"

from headroom.agent_savings import proxy_pipeline_kwargs, seed_proxy_env_defaults

seed_proxy_env_defaults()

from headroom.proxy.models import ProxyConfig
from headroom.proxy.server import HeadroomProxy
from headroom.transforms.content_router import ContentRouter

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(("OK   " if ok else "FAIL ") + label)
    if not ok:
        failures.append(label)


check(ContentRouter.apply.__name__ == "_hd_trw_apply", "trw bound")

cfg = ProxyConfig(mode="token", savings_profile="coding", code_aware_enabled=True)
kwargs = proxy_pipeline_kwargs(cfg)
print(f"INFO persona read_protection_window={kwargs.get('read_protection_window')}")
pipeline = HeadroomProxy(cfg).anthropic_pipeline

# A Claude Code Read: `N\t` line numbers over source code.
body = "\n".join(
    f"{i}\tdef handler_{i}(request, items):\n{i}\t    return [x for x in items if x.id == {i}]"
    for i in range(1, 160)
)


def run(tail_turns: int) -> tuple[bool, list[str]]:
    messages = [
        {"role": "user", "content": "open the handlers"},
        {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "/x/h.py"}}
            ],
        },
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": body}]},
    ]
    for k in range(tail_turns):
        messages += [
            {"role": "assistant", "content": f"step {k} done"},
            {"role": "user", "content": f"continue {k}"},
        ]
    result = pipeline.apply(messages, "claude-sonnet-4-5", model_limit=200000, **kwargs)
    out = result.messages[2]["content"][0]["content"]
    return out == body, list(result.transforms_applied)


exact, transforms = run(0)
check(
    exact and "router:excluded:tool" in transforms,
    f"newest Read excluded and byte-exact {transforms}",
)
# 43 messages: token mode protects the last max(4, 0.3 * 43) = 12, and this Read
# sits 41 from the end, so the vendor must not turn into "protect everything".
_, transforms = run(20)
check("router:excluded:tool" not in transforms, f"aged Read still compressible {transforms}")

sys.exit(1 if failures else 0)
