import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { HeadroomPricingStatus, RuntimeStatus } from "./types";

const NEEDS_AUTH_KEY = "headroom_urgent_needs_auth_date";
const OPTIMIZATION_BLOCKED_KEY = "headroom_urgent_opt_blocked_date";
const RUNTIME_DOWN_KEY = "headroom_urgent_runtime_down_date";
// Single daily slot for the upgrade nudge: either a usage-based nudge or, when
// no threshold is crossed, a generic reminder. One key keeps the two mutually
// exclusive so a gated free user gets at most one upgrade nudge per ~24h.
const DAILY_NUDGE_KEY = "headroom_urgent_nudge_date";
const NUDGE_REMINDER_TITLE = "Headroom is ready when you are";
const NUDGE_REMINDER_BODY =
  "You're on the free plan. Upgrade to keep Headroom optimizing every prompt.";

// Codex uses a storage key distinct from the Claude gate so a Claude
// notification firing in the same window can't suppress the Codex one.
const CODEX_OPTIMIZATION_BLOCKED_KEY = "headroom_urgent_codex_opt_blocked_date";

const NUDGE_PREFIXES: Record<number, string> = {
  1: "Heads up",
  2: "Getting close",
  3: "Almost paused",
};

// Titles quote the gate's actual tier-dependent ladder (10/15/20 -> 25 for
// Max-like plans, 25/35/45 -> 50 for Pro-like) — hardcoded numbers here used
// to tell Max users "25% of your weekly usage" when they were at 10%.
function usageNudgeTitle(
  product: "Claude" | "Codex",
  level: number,
  thresholds: number[] | null | undefined,
  disableAt: number | null | undefined
): string {
  const prefix = NUDGE_PREFIXES[level] ?? "Heads up";
  const pct = thresholds?.[level - 1];
  if (pct == null) return `${prefix}: weekly ${product} usage rising`;
  const pause = disableAt != null ? ` (Headroom pauses at ${disableAt}%)` : "";
  return `${prefix}: ${pct}% of your weekly ${product} usage${pause}`;
}

export async function maybeFireUrgentPricingNotifications(
  status: HeadroomPricingStatus
): Promise<void> {
  if (await isWindowVisible()) return;

  if (status.needsAuthentication) {
    await fireOncePerDay(
      NEEDS_AUTH_KEY,
      "Headroom needs you to sign in",
      status.gateMessage ||
        "Sign in to Headroom to keep optimization running.",
      "signin"
    );
    return;
  }

  if (!status.optimizationAllowed) {
    await fireOncePerDay(
      OPTIMIZATION_BLOCKED_KEY,
      "Headroom optimization is off",
      status.gateMessage ||
        "Your current plan has optimization disabled. Open Headroom to review.",
      "billing"
    );
    return;
  }

  const codex = status.codex;
  if (codex && !codex.optimizationAllowed) {
    await fireOncePerDay(
      CODEX_OPTIMIZATION_BLOCKED_KEY,
      "Headroom optimization is off",
      codex.gateMessage ||
        "Codex optimization is paused. Open Headroom to review.",
      "billing"
    );
    return;
  }

  // One upgrade nudge per ~24h for gated free users. When a weekly usage
  // threshold is crossed we show the usage-based copy, otherwise a generic
  // reminder so we never go silent. Claude/Codex already track the weekly
  // window for us, so there's no separate weekly gate here -- the daily key is
  // the only throttle, and it's shared so the two paths can't both fire.
  if (!isGatedFreeAccount(status)) return;

  const usage = pickUsageNudge(status);
  await fireOncePerDay(
    DAILY_NUDGE_KEY,
    usage?.title ?? NUDGE_REMINDER_TITLE,
    usage?.body ?? NUDGE_REMINDER_BODY,
    "billing"
  );
}

// Highest usage nudge currently active across Claude and Codex, or null when
// neither has crossed a threshold. Ties go to Claude.
function pickUsageNudge(
  status: HeadroomPricingStatus
): { title: string; body: string } | null {
  const claudeLevel =
    status.shouldNudge && status.nudgeLevel > 0 ? Math.min(status.nudgeLevel, 3) : 0;
  const codex = status.codex;
  const codexLevel =
    codex && codex.shouldNudge && codex.nudgeLevel > 0
      ? Math.min(codex.nudgeLevel, 3)
      : 0;

  if (claudeLevel === 0 && codexLevel === 0) return null;

  if (codexLevel > claudeLevel) {
    return {
      title: usageNudgeTitle(
        "Codex",
        codexLevel,
        codex!.effectiveNudgeThresholdsPercent,
        codex!.effectiveDisableThresholdPercent
      ),
      body:
        codex!.gateMessage ||
        "Headroom will pause Codex optimization at your weekly cap. Upgrade to keep going.",
    };
  }

  return {
    title: usageNudgeTitle(
      "Claude",
      claudeLevel,
      status.effectiveNudgeThresholdsPercent,
      status.effectiveDisableThresholdPercent
    ),
    body:
      status.gateMessage ||
      "Headroom will pause optimization at your weekly usage cap. Upgrade to keep going.",
  };
}

// A gated free account: authenticated, optimization still allowed, but no
// active subscription or trial. Mirrors the backend gate that drives shouldNudge.
function isGatedFreeAccount(status: HeadroomPricingStatus): boolean {
  const account = status.account;
  return (
    !status.needsAuthentication &&
    status.optimizationAllowed &&
    !!account &&
    !account.subscriptionActive &&
    !account.trialActive
  );
}

// On a clean install the first cold boot warms an ONNX embedder before
// /readyz goes green, so `running` is briefly false on a perfectly healthy
// launch and the runtime-down gate below would fire a false "stopped running"
// notice. Stay quiet until the runtime has been reachable once this session; a
// real crash after a good boot still fires. Fallback: if it never comes up
// within the grace window (and there's no hard startup error to surface
// sooner), notify anyway so a genuinely stuck first boot isn't silent forever.
const RUNTIME_DOWN_GRACE_MS = 5 * 60 * 1000;
let everReachable = false;
let firstDownSeenAt: number | null = null;

// Test-only: reset the cross-call first-boot state.
export function __resetRuntimeNotificationState(): void {
  everReachable = false;
  firstDownSeenAt = null;
}

export async function maybeFireUrgentRuntimeNotification(
  runtime: RuntimeStatus
): Promise<void> {
  if (runtime.running) {
    everReachable = true;
    firstDownSeenAt = null;
  }

  if (await isWindowVisible()) return;

  const runtimeDown =
    runtime.installed && !runtime.running && !runtime.starting && !runtime.paused;
  if (!runtimeDown) return;

  const hasHardError = !!(runtime.startupError || runtime.startupErrorHint);
  if (!everReachable && !hasHardError) {
    const now = Date.now();
    if (firstDownSeenAt === null) firstDownSeenAt = now;
    if (now - firstDownSeenAt < RUNTIME_DOWN_GRACE_MS) return;
  }

  const body = runtime.startupErrorHint
    ? `Headroom isn't running. ${runtime.startupErrorHint}`
    : runtime.startupError
    ? `Headroom isn't running: ${runtime.startupError}`
    : "Headroom isn't running. Open the tray to restart it.";

  await fireOncePerDay(
    RUNTIME_DOWN_KEY,
    "Headroom stopped running",
    body,
    "runtime"
  );
}

// Returns true when a notification was actually shown (false when throttled).
async function fireOncePerDay(
  storageKey: string,
  title: string,
  body: string,
  action: string
): Promise<boolean> {
  // Local day, not UTC: with a UTC key the throttle window flips mid-afternoon
  // for US users, letting two nudges land in one local day (and training
  // people to disable notifications on the channel urgent alerts share).
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  if (localStorage.getItem(storageKey) === today) return false;
  try {
    await invoke("show_notification", { title, body, action });
    localStorage.setItem(storageKey, today);
    return true;
  } catch {
    // best-effort
    return false;
  }
}

async function isWindowVisible(): Promise<boolean> {
  return getCurrentWindow()
    .isVisible()
    .catch(() => true);
}
