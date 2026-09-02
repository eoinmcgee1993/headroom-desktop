"""Behavioural check of the vendored upstream #3380 prefix floor.

Run by `vendored_prefix_floor_behaves_against_the_installed_wheel` in
tool_manager.rs against the SITECUSTOMIZE_PY we are about to ship, executed
on the real installed 0.37.0 wheel.

This exists because string assertions are not enough here. The 0.9.4 splice
passed every `py.contains(...)` check it had and still cost 89 installs ~17pp
of their savings rate: presence proves the code is there, not that it behaves.
Every case below is a property whose violation is a known, expensive failure.

Prints one PASS/FAIL line per case; exits 1 on any failure.
"""
import copy, sys
import headroom.cache.prefix_tracker as pt
import headroom.proxy.session_engine as se

fails = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)

def M(r, t):
    return {"role": r, "content": t}

# Three previously-forwarded messages; background compression has since found a
# SMALLER form for all three. Stock 0.37.0 declines that replay (it "inflates")
# and busts the provider cache -- the bug this vendor exists to fix.
prev_orig = [M("user", "READ a.py\n" + "x" * 4000), M("assistant", "ok"),
             M("user", "READ b.py\n" + "y" * 4000)]
prev_fwd = [M("user", "READ a<v1-compressed>"), M("assistant", "ok"),
            M("user", "READ b<v1-compressed>")]
cur = prev_orig + [M("user", "new turn")]
optimized = [M("user", "a<v2>"), M("assistant", "ok"), M("user", "b<v2>"), M("user", "new")]

check("vendor bound (confirmed_frozen_count in signature)",
      "confirmed_frozen_count" in pt.overlay_cached_prefix.__code__.co_varnames)

# T1: inside the provider-confirmed floor, replay is UNCONDITIONAL. Sending
# anything else there can only bust bytes the provider already holds.
out = pt.overlay_cached_prefix(copy.deepcopy(optimized), cur, prev_orig, prev_fwd,
                              confirmed_frozen_count=3)
check("T1 full floor replays every confirmed message", out[:3] == prev_fwd)
check("T1 this turn's fresh tail still ships", out[3] == optimized[3])

# T2: the capability the floor buys. Position 0 is confirmed and must replay;
# position 2 is BEYOND the floor, so the improvement there is allowed to land.
# The 0.9.4 splice got this wrong in the other direction and shipped drift.
out = pt.overlay_cached_prefix(copy.deepcopy(optimized), cur, prev_orig, prev_fwd,
                              confirmed_frozen_count=1)
check("T2 confirmed position replays", out[0] == prev_fwd[0])
check("T2 beyond-floor improvement lands", out[2] == optimized[2])

# T3: a collapsed floor (cold cache / TTL lapse) must re-baseline, never
# silently keep replaying a prefix the provider no longer holds.
out = pt.overlay_cached_prefix(copy.deepcopy(optimized), cur, prev_orig, prev_fwd,
                              confirmed_frozen_count=0)
check("T3 floor 0 does not force replay", out[0] == optimized[0])

# T4: floorless callers (OpenAI paths, cache mode) fall back to FULL replay --
# the cache-safe posture, never a partial one.
out = pt.overlay_cached_prefix(copy.deepcopy(optimized), cur, prev_orig, prev_fwd,
                              confirmed_frozen_count=len(prev_fwd))
check("T4 floorless fallback replays everything", out[:3] == prev_fwd)

# T5: alignment guards survive the vendor. A changed leading message means the
# forwarded bytes no longer correspond position-for-position; replaying then
# corrupts rather than repairs.
misaligned = [M("user", "TOTALLY DIFFERENT")] + cur[1:]
out = pt.overlay_cached_prefix(copy.deepcopy(optimized), misaligned, prev_orig, prev_fwd,
                              confirmed_frozen_count=3)
check("T5 refuses on misaligned history", out == optimized)

# T6: the bridge. The floor is NOT passed by the handler -- it is stashed by
# prepare_turn (pre-clamp tracker_frozen) into a ContextVar and consumed by
# finalize_turn. That indirection is the novel, riskiest part of the vendor, so
# drive it end to end rather than inspecting a signature.
class _Cache:
    def compute_frozen_count(self, messages):
        return len(messages)

    def mark_stable_from_messages(self, messages, frozen):
        pass

    def apply_cached(self, messages):
        return list(messages)

se.prepare_turn(_Cache(), cur, policy=se.FREEZE_POLICY_CONFIRMED_CLAMP, tracker_frozen=1)
final = se.finalize_turn(copy.deepcopy(optimized), cur, prev_orig, prev_fwd)
check("T6 bridged floor replays the confirmed position", final.messages[0] == prev_fwd[0])
check("T6 bridged floor lets the beyond-floor improvement land",
      final.messages[2] == optimized[2])

# T7: the floor is one-shot. A second finalize with no intervening prepare must
# NOT reuse the previous turn's floor -- a stale floor is a wrong floor, and a
# wrong floor is how bytes the provider still holds get overwritten.
final2 = se.finalize_turn(copy.deepcopy(optimized), cur, prev_orig, prev_fwd)
check("T7 stale floor is not reused (falls back to full replay)",
      final2.messages[:3] == prev_fwd)

# T8: the OTHER replay path. When a turn APPENDS content blocks to an existing
# message (every Claude Code tool_result), the overlay merges replayed blocks
# with new ones instead of swapping whole messages -- a separate branch with a
# separate floor check. An earlier version of this probe used only whole-message
# cases and passed while that branch was deliberately broken, so it is covered
# explicitly.
def blocks(*texts):
    return [{"type": "text", "text": t} for t in texts]

# The branch fires when the pipeline emitted the ORIGINAL leading blocks (the
# freeze path) and appended new ones. Handing it an already-recompressed
# leading block takes it out of this branch by design -- an earlier draft of
# this case did exactly that and looked like a product bug.
b_orig_block = "READ a.py\n" + "x" * 4000
b_prev_orig = [{"role": "user", "content": blocks(b_orig_block)}]
b_prev_fwd = [{"role": "user", "content": blocks("READ a<v1-compressed>")}]
b_cur = [{"role": "user", "content": blocks(b_orig_block, "tool_result tail")}]
b_optimized = [{"role": "user", "content": blocks(b_orig_block, "tool_result tail")}]

out = pt.overlay_cached_prefix(copy.deepcopy(b_optimized), b_cur, b_prev_orig, b_prev_fwd,
                              confirmed_frozen_count=1)
check("T8 confirmed block-append message replays its cached blocks",
      out[0]["content"][0] == b_prev_fwd[0]["content"][0])
check("T8 newly appended block still ships",
      out[0]["content"][-1]["text"] == "tool_result tail")

# T9: the block-append floor check, pinned directly. T8 cannot exercise it --
# there the replay is compressed bytes against original bytes, so it always
# SHRINKS and the size bound never fires whether or not the floor is honoured.
# This forces the inflating case (previously-forwarded larger than the current
# optimized form, which happens once an earlier replay has already compounded):
# inside the confirmed floor that replay must STILL happen, because those bytes
# are what the provider cached and sending anything else busts the suffix.
b2_prev_orig = [{"role": "user", "content": blocks(b_orig_block)}]
b2_prev_fwd = [{"role": "user", "content": blocks("Z" * 9000)}]
b2_cur = [{"role": "user", "content": blocks(b_orig_block, "tool_result tail")}]
b2_optimized = [{"role": "user", "content": blocks(b_orig_block, "tool_result tail")}]

out = pt.overlay_cached_prefix(copy.deepcopy(b2_optimized), b2_cur, b2_prev_orig, b2_prev_fwd,
                              confirmed_frozen_count=1)
check("T9 inflating block replay INSIDE the floor still replays",
      out[0]["content"][0]["text"] == "Z" * 9000)

# ...and beyond the floor the same inflating replay must be declined, or every
# turn pays for bytes the provider is not holding.
out = pt.overlay_cached_prefix(copy.deepcopy(b2_optimized), b2_cur, b2_prev_orig, b2_prev_fwd,
                              confirmed_frozen_count=0)
check("T9 inflating block replay OUTSIDE the floor is declined",
      out[0]["content"][0]["text"] == b_orig_block)

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
