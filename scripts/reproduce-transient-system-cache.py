"""Offline diagnostic for the September 7 Fable cache-loss incident.

Run with the managed Headroom Python. By default this uses synthetic messages;
--capture accepts the three captured transformations from the investigation
and compares the last good request with the first bad request. Private request
bodies are never printed. No provider calls are made: socket access is blocked.

By default exit 0 means the historical bug was reproduced. --expect-fixed
instead requires tracker retention and runs the isolation regression checks.
--sitecustomize optionally loads the installed desktop vendor before probing.
This probes tracker selection and byte replay, not provider cache billing.
"""

import argparse
import copy
import inspect
import json
import os
from pathlib import Path
import runpy
import socket


def deny_network(*args, **kwargs):
    raise AssertionError("This reproducer must remain offline")


def synthetic_pair():
    history = [
        {"role": "user", "content": "Inspect example.py."},
        {"role": "assistant", "content": "Reading the file."},
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "read-1",
                         "content": "original source line\n" * 400}],
        },
    ]
    reminder = {"role": "system", "content": "Batch independent tools this turn."}
    previous = history + [reminder]
    current = history + [
        {"role": "assistant", "content": "Now run the checks."},
        {"role": "user", "content": "The checks passed."},
        copy.deepcopy(reminder),
    ]
    forwarded = copy.deepcopy(previous)
    processed = copy.deepcopy(current)
    forwarded[2]["content"][0]["content"] = "previously cached compressed result"
    processed[2]["content"][0]["content"] = "a different compressed result that rewrites old history"
    return previous, forwarded, current, processed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--sitecustomize", type=Path)
    parser.add_argument("--expect-fixed", action="store_true")
    args = parser.parse_args()

    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    if args.sitecustomize:
        os.environ["HEADROOM_SDK"] = "headroom-desktop-proxy"
        runpy.run_path(str(args.sitecustomize))

    from headroom.cache.prefix_tracker import (
        SessionTrackerStore,
        _canonicalize_for_prefix_compare as canonical,
        classify_history_relation,
        overlay_cached_prefix,
    )

    if args.capture:
        previous_capture, current_capture = json.loads(args.capture.read_text())[-2:]
        previous = previous_capture["request_messages"]
        forwarded = previous_capture["compressed_messages"]
        current = current_capture["request_messages"]
        processed = current_capture["compressed_messages"]
    else:
        previous, forwarded, current, processed = synthetic_pair()

    assert previous[-1]["role"] == "system"
    stable_length = len(previous) - 1
    assert canonical(current[:stable_length]) == canonical(previous[:-1])
    assert classify_history_relation(current, previous).kind == "diverged"
    assert classify_history_relation(current, previous[:-1]).kind == "message_append"

    store = SessionTrackerStore()
    prior = store.resolve_tracker("same-session", "anthropic", messages=previous,
                                  cache_affinity="same-model-tools-thinking")
    # Seed a confirmed cache, without pretending these synthetic counts are
    # provider measurements. The question is whether selection retains it.
    prior.update_from_response(
        cache_read_tokens=0, cache_write_tokens=1_000_000,
        messages=forwarded, original_messages=previous,
        message_token_counts=[100] * len(previous),
    )
    assert prior.get_frozen_message_count() > 0
    following = store.resolve_tracker("same-session", "anthropic", messages=current,
                                      cache_affinity="same-model-tools-thinking")
    if args.expect_fixed:
        assert following is prior, "unchanged history lost its tracker"
        assert following.get_frozen_message_count() == prior.get_frozen_message_count() > 0
        verify_isolation()
    else:
        assert following is not prior
        assert following.get_frozen_message_count() == 0

    kwargs = {}
    if "confirmed_frozen_count" in inspect.signature(overlay_cached_prefix).parameters:
        kwargs["confirmed_frozen_count"] = prior.get_frozen_message_count()
    # The existing overlay must stop before the replaced reminder.
    repaired = overlay_cached_prefix(copy.deepcopy(processed), current,
                                     previous, forwarded, **kwargs)
    assert canonical(repaired[:stable_length]) == canonical(forwarded[:-1])
    assert repaired[stable_length:] == processed[stable_length:]
    assert canonical(processed[:stable_length]) != canonical(forwarded[:-1])
    print("PASS: tracker retention and isolation" if args.expect_fixed else
          "REPRODUCED: temporary system tail loses confirmed tracker state")
    print("PASS: unchanged forwarded prefix restored; current tail preserved")
    print(f"Unchanged historical messages: {stable_length}; no network calls")


def verify_isolation():
    from headroom.cache import prefix_tracker as pt

    previous, _, current, _ = synthetic_pair()

    def resolve(store, messages, affinity="same", provider="anthropic"):
        return store.resolve_tracker("session", provider, messages, affinity)

    def seeded():
        store = pt.SessionTrackerStore()
        return store, resolve(store, previous)

    store, prior = seeded()
    assert resolve(store, current, "different-tools") is not prior
    store, prior = seeded()
    changed = copy.deepcopy(current)
    changed[0]["content"] = "Different conversation"
    assert resolve(store, changed) is not prior
    store, prior = seeded()
    assert resolve(store, current, provider="openai") is not prior
    store, prior = seeded()
    assert resolve(store, previous + [{"role": "assistant", "content": "append"}]) is prior

    # Leading and historical system instructions remain part of identity.
    for index in (0, 2):
        before, after = copy.deepcopy(previous), copy.deepcopy(current)
        before.insert(index, {"role": "system", "content": "original instruction"})
        after.insert(index, {"role": "system", "content": "changed instruction"})
        store = pt.SessionTrackerStore()
        prior = resolve(store, before)
        assert resolve(store, after) is not prior

    # Store full snapshots even while the reminder moves and changes.
    store, prior = seeded()
    for i in range(4):
        current[-1]["content"] = f"Current instruction {i}"
        assert resolve(store, current) is prior
        assert store._lineages["session"]["session"] == pt._lineage_snapshot(
            pt._canonicalize_for_prefix_compare(current))
        current = current[:-1] + [{"role": "assistant", "content": f"reply {i}"},
                                 {"role": "system", "content": "next reminder"}]

    # Existing sibling snapshots can predate the shim.
    store, prior = seeded()
    sibling = copy.deepcopy(previous)
    sibling[-1]["content"] = "other reminder"
    other = store.get_or_create("session\x00sibling", "anthropic")
    store._lineages["session"]["session\x00sibling"] = pt._lineage_snapshot(
        pt._canonicalize_for_prefix_compare(sibling))
    store._lineage_affinities["session\x00sibling"] = "same"
    assert resolve(store, current) not in (prior, other), "ambiguous siblings merged"
    assert resolve(store, sibling) is other, "exact match must win"

    store, prior = seeded()
    prior._last_activity = 0
    store._last_cleanup = 0
    assert resolve(store, current) is not prior, "expired tracker resurrected"

    store = pt.SessionTrackerStore(pt.PrefixFreezeConfig(max_lineages_per_session=1))
    prior = resolve(store, previous)
    assert resolve(store, current) is prior, "continuation at capacity overflowed"
    assert resolve(store, changed) is not prior
    print("PASS: affinity/history/provider isolation, append, moving reminders, "
          "full snapshots, ambiguity, exact precedence, expiry, capacity")


if __name__ == "__main__":
    main()
