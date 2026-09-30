import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeadroomPricingStatus, RuntimeStatus } from "./types";
import {
  __resetRuntimeNotificationState,
  fireUpsellNudge,
  localDayKey,
  maybeFireUrgentPricingNotifications,
  maybeFireUrgentRuntimeNotification,
} from "./urgentNotifications";

const { invokeMock, isVisibleMock, windows } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isVisibleMock: vi.fn(),
  // The calling webview's label, and whether the OTHER Headroom window is on
  // screen. isVisibleMock is the calling (main) window.
  windows: { label: "main", otherVisible: false },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windows.label, isVisible: isVisibleMock }),
  getAllWindows: async () => [
    { isVisible: isVisibleMock },
    { isVisible: async () => windows.otherVisible },
  ],
}));

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    },
  });
  return values;
}

afterEach(() => {
  windows.label = "main";
  windows.otherVisible = false;
});

function makePricing(
  overrides: Partial<HeadroomPricingStatus> = {}
): HeadroomPricingStatus {
  return {
    authenticated: true,
    localGraceStartedAt: new Date().toISOString(),
    localGraceEndsAt: new Date().toISOString(),
    localGraceActive: false,
    accountSyncError: null,
    needsAuthentication: false,
    optimizationAllowed: true,
    shouldNudge: false,
    nudgeLevel: 0,
    gateReason: null,
    gateMessage: "",
    nudgeThresholdPercent: null,
    effectiveNudgeThresholdsPercent: [25, 35, 45],
    disableThresholdPercent: null,
    effectiveDisableThresholdPercent: 50,
    recommendedSubscriptionTier: null,
    claude: {
      authMethod: "claude_ai_oauth",
      email: null,
      displayName: null,
      planTier: "free",
      hasExtraUsageEnabled: false,
    },
    account: null,
    launchDiscountActive: false,
    ...overrides,
  };
}

function makeCodex(
  overrides: Partial<NonNullable<HeadroomPricingStatus["codex"]>> = {}
): NonNullable<HeadroomPricingStatus["codex"]> {
  return {
    limitName: null,
    primary: null,
    secondary: null,
    creditsBalance: null,
    creditsUnlimited: false,
    optimizationAllowed: true,
    shouldNudge: false,
    nudgeLevel: 0,
    gateReason: null,
    recommendedSubscriptionTier: null,
    weeklyUsedPercent: null,
    gateMessage: "",
    effectiveNudgeThresholdsPercent: [25, 35, 45],
    effectiveDisableThresholdPercent: 50,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    platform: "darwin",
    supportTier: "supported",
    installed: true,
    running: true,
    starting: false,
    paused: false,
    autoPaused: false,
    bypassed: false,
    proxyReachable: true,
    headroomLearnSupported: true,
    rtk: {
      installed: true,
      enabled: true,
      pathConfigured: true,
      hookConfigured: true,
    },
    ...overrides,
  };
}

describe("maybeFireUrgentPricingNotifications", () => {
  const gatedFreeAccount: NonNullable<HeadroomPricingStatus["account"]> = {
    email: "free@example.com",
    trialActive: false,
    subscriptionActive: false,
    acceptedInvitesCount: 0,
    inviteBonusPercent: 0,
  };

  afterEach(() => {
    invokeMock.mockReset();
    isVisibleMock.mockReset();
  });

  it("does not fire when the window is visible", async () => {
    isVisibleMock.mockResolvedValue(true);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("treats isVisible failures as visible to avoid spamming", async () => {
    isVisibleMock.mockRejectedValue(new Error("bridge down"));
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires only from the main webview, and not while any Headroom window is on screen", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();
    const status = makePricing({ needsAuthentication: true });

    // The launcher webview polls pricing too; it must never notify.
    windows.label = "launcher";
    await maybeFireUrgentPricingNotifications(status);
    expect(invokeMock).not.toHaveBeenCalled();

    // Main is hidden but the launcher is on screen (onboarding): stay quiet.
    windows.label = "main";
    windows.otherVisible = true;
    await maybeFireUrgentPricingNotifications(status);
    expect(invokeMock).not.toHaveBeenCalled();

    windows.otherVisible = false;
    await maybeFireUrgentPricingNotifications(status);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("fires once when two overlapping ticks race for the same day slot", async () => {
    isVisibleMock.mockResolvedValue(false);
    invokeMock.mockResolvedValue(undefined);
    installStorage();
    const status = makePricing({ needsAuthentication: true });

    await Promise.all([
      maybeFireUrgentPricingNotifications(status),
      maybeFireUrgentPricingNotifications(status),
    ]);

    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("hands the day slot back when the notification fails", async () => {
    isVisibleMock.mockResolvedValue(false);
    invokeMock.mockRejectedValueOnce(new Error("notifications disabled"));
    const store = installStorage();
    const status = makePricing({ needsAuthentication: true });

    await maybeFireUrgentPricingNotifications(status);
    expect(store.has("headroom_urgent_needs_auth_date")).toBe(false);

    await maybeFireUrgentPricingNotifications(status);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("fires the needs-auth notification with the signin action", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true, gateMessage: "Sign in required." })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom needs you to sign in",
      body: "Sign in required.",
      action: "signin",
    });
  });

  it("falls back to default copy when gateMessage is empty", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true, gateMessage: "" })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom needs you to sign in",
      body: "Sign in to Headroom to keep optimization running.",
      action: "signin",
    });
  });

  it("fires the optimization-blocked notification when the plan gate is on", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        optimizationAllowed: false,
        gateMessage: "Plan does not allow optimization.",
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom optimization is off",
      body: "Plan does not allow optimization.",
      action: "billing",
    });
  });

  it("prefers needs-auth over the plan gate when both are active", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        needsAuthentication: true,
        optimizationAllowed: false,
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ action: "signin" })
    );
  });

  it("does not repeat a notification already fired today", async () => {
    isVisibleMock.mockResolvedValue(false);
    const today = localDayKey(new Date());
    installStorage({ headroom_urgent_needs_auth_date: today });

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("records today's date after sending", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();
    const today = localDayKey(new Date());

    await maybeFireUrgentPricingNotifications(
      makePricing({ needsAuthentication: true })
    );

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "headroom_urgent_needs_auth_date",
      today
    );
  });

  it("swallows invoke errors without throwing", async () => {
    isVisibleMock.mockResolvedValue(false);
    invokeMock.mockRejectedValueOnce(new Error("notifications disabled"));
    installStorage();

    await expect(
      maybeFireUrgentPricingNotifications(
        makePricing({ needsAuthentication: true })
      )
    ).resolves.toBeUndefined();
  });

  it("does not fire when pricing is healthy", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(makePricing());

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires the level-1 nudge when the user crosses 25%", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        shouldNudge: true,
        nudgeLevel: 1,
        gateMessage: "You're at 27.0% of weekly Claude usage.",
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Heads up: 25% of your weekly Claude usage (Headroom pauses at 50%)",
      body: "You're at 27.0% of weekly Claude usage.",
      action: "billing",
    });
  });

  it("fires at most one upgrade nudge per day across rising levels", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount, shouldNudge: true, nudgeLevel: 1, gateMessage: "25%" })
    );
    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount, shouldNudge: true, nudgeLevel: 2, gateMessage: "35%" })
    );
    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount, shouldNudge: true, nudgeLevel: 3, gateMessage: "45%" })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ title: "Heads up: 25% of your weekly Claude usage (Headroom pauses at 50%)" })
    );
  });

  it("does not fire a second upgrade nudge the same day", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount, shouldNudge: true, nudgeLevel: 2, gateMessage: "35%" })
    );
    invokeMock.mockClear();
    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount, shouldNudge: true, nudgeLevel: 2, gateMessage: "36%" })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("prefers the optimization-blocked notification over a nudge when both apply", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        optimizationAllowed: false,
        shouldNudge: true,
        nudgeLevel: 3,
        gateMessage: "Headroom is paused.",
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ action: "billing", title: "Headroom optimization is off" })
    );
  });

  it("does not fire a nudge when shouldNudge is false even if level > 0", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ shouldNudge: false, nudgeLevel: 2 })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires a generic daily reminder for a gated free account with no usage nudge", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom is ready when you are",
      body: "You're on the free plan. Upgrade to keep Headroom optimizing every prompt.",
      action: "billing",
    });
  });

  it("fires the generic reminder at most once per day", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage({
      headroom_urgent_nudge_date: localDayKey(new Date()),
    });

    await maybeFireUrgentPricingNotifications(
      makePricing({ account: gatedFreeAccount })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires the usage nudge instead of the generic reminder when a threshold is crossed", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        shouldNudge: true,
        nudgeLevel: 1,
        gateMessage: "25%",
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ title: "Heads up: 25% of your weekly Claude usage (Headroom pauses at 50%)" })
    );
  });

  it("does not fire the generic reminder for a subscribed account", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: { ...gatedFreeAccount, subscriptionActive: true },
      })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire the generic reminder during an active trial", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: { ...gatedFreeAccount, trialActive: true },
      })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires a Codex optimization-blocked notification when the Codex gate is off", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        codex: makeCodex({
          optimizationAllowed: false,
          gateMessage:
            "Headroom is paused because you've reached 50.0% of weekly Codex usage.",
        }),
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom optimization is off",
      body: "Headroom is paused because you've reached 50.0% of weekly Codex usage.",
      action: "billing",
    });
  });

  it("fires the Codex level-1 nudge with Codex wording", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        codex: makeCodex({
          shouldNudge: true,
          nudgeLevel: 1,
          gateMessage: "You're at 27.0% of weekly Codex usage.",
        }),
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Heads up: 25% of your weekly ChatGPT Codex usage (Headroom pauses at 50%)",
      body: "You're at 27.0% of weekly Codex usage.",
      action: "billing",
    });
  });

  it("quotes the Max-tier ladder in nudge titles instead of the hardcoded Pro one", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    // ChatGPT Pro / Claude Max users nudge at 10/15/20 and pause at 25 —
    // the title must quote those numbers, not the 25/35/45 Pro ladder.
    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        codex: makeCodex({
          shouldNudge: true,
          nudgeLevel: 1,
          gateMessage: "You're at 12.0% of weekly Codex usage.",
          effectiveNudgeThresholdsPercent: [10, 15, 20],
          effectiveDisableThresholdPercent: 25,
        }),
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Heads up: 10% of your weekly ChatGPT Codex usage (Headroom pauses at 25%)",
      body: "You're at 12.0% of weekly Codex usage.",
      action: "billing",
    });
  });

  it("fires only the higher-level nudge when both Claude and Codex cross", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        shouldNudge: true,
        nudgeLevel: 1,
        gateMessage: "Claude 27%",
        codex: makeCodex({
          shouldNudge: true,
          nudgeLevel: 2,
          gateMessage: "Codex 36%",
        }),
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Getting close: 35% of your weekly ChatGPT Codex usage (Headroom pauses at 50%)",
      body: "Codex 36%",
      action: "billing",
    });
  });

  it("breaks a Claude/Codex tie in favor of Claude", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        account: gatedFreeAccount,
        shouldNudge: true,
        nudgeLevel: 1,
        gateMessage: "Claude 27%",
        codex: makeCodex({ shouldNudge: true, nudgeLevel: 1, gateMessage: "Codex 27%" }),
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ title: "Heads up: 25% of your weekly Claude usage (Headroom pauses at 50%)" })
    );
  });

  it("prefers the needs-auth notification over a Codex nudge", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await maybeFireUrgentPricingNotifications(
      makePricing({
        needsAuthentication: true,
        codex: makeCodex({ shouldNudge: true, nudgeLevel: 3, gateMessage: "Codex 46%" }),
      })
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ action: "signin" })
    );
  });
});

describe("maybeFireUrgentRuntimeNotification", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
  });
  afterEach(() => {
    nowSpy.mockRestore();
    invokeMock.mockReset();
    isVisibleMock.mockReset();
    __resetRuntimeNotificationState();
  });

  // One status reading taken at `at` ms.
  async function readAt(at: number, runtime: RuntimeStatus): Promise<void> {
    nowSpy.mockReturnValue(at);
    await maybeFireUrgentRuntimeNotification(runtime);
  }

  // Two readings spanning the 45s confirm window: enough to fire when the
  // reading itself warrants it, so the quiet cases below are quiet for their
  // own reason, not for want of a second reading.
  async function readSustained(runtime: RuntimeStatus): Promise<void> {
    await readAt(0, runtime);
    await readAt(45_000, runtime);
  }

  it("fires when the runtime stays down after having been reachable", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    // A healthy boot first, so this isn't the first-boot cold-start window.
    await readAt(0, makeRuntime({ running: true }));
    await readAt(0, makeRuntime({ running: false }));
    expect(invokeMock).not.toHaveBeenCalled();
    await readAt(30_000, makeRuntime({ running: false }));
    expect(invokeMock).not.toHaveBeenCalled();
    await readAt(45_000, makeRuntime({ running: false }));

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom stopped running",
      body: "Headroom isn't running. Open the tray to restart it.",
      action: "runtime",
    });
  });

  it("does not fire on a single down reading", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readAt(30_000, makeRuntime({ running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire on a down gap shorter than 45s", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readAt(10_000, makeRuntime({ running: false }));
    await readAt(54_999, makeRuntime({ running: false }));
    // Self-healed (a watchdog respawn, a post-wake /readyz lag).
    await readAt(60_000, makeRuntime({ running: true }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("recovery resets the down streak", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readAt(10_000, makeRuntime({ running: false }));
    await readAt(40_000, makeRuntime({ running: true }));
    // 50s after the first down reading, but only 30s into this streak.
    await readAt(60_000, makeRuntime({ running: false }));
    await readAt(90_000, makeRuntime({ running: false }));
    expect(invokeMock).not.toHaveBeenCalled();

    await readAt(105_000, makeRuntime({ running: false }));
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ action: "runtime" })
    );
  });

  it("a watchdog restart in progress ends the down streak", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readAt(10_000, makeRuntime({ running: false }));
    await readAt(40_000, makeRuntime({ running: false, starting: true }));
    await readAt(70_000, makeRuntime({ running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a reading gap across sleep starts a new streak", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readAt(10_000, makeRuntime({ running: false }));
    // Asleep for ten minutes: the first reading after wake is a new streak.
    await readAt(610_000, makeRuntime({ running: false }));
    expect(invokeMock).not.toHaveBeenCalled();

    await readAt(655_000, makeRuntime({ running: false }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stays quiet during the first-boot cold-start window", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    // Never reachable yet, no hard error: the /readyz warmup window.
    await readSustained(makeRuntime({ running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires on first boot once the grace window elapses", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readAt(0, makeRuntime({ running: false }));
    await readAt(150_000, makeRuntime({ running: false }));
    expect(invokeMock).not.toHaveBeenCalled();

    await readAt(5 * 60 * 1000 + 1, makeRuntime({ running: false }));
    expect(invokeMock).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({ action: "runtime" })
    );
  });

  it("surfaces the startup error when one is present", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readSustained(
      makeRuntime({ running: false, startupError: "port 6767 busy" })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom stopped running",
      body: "Headroom isn't running: port 6767 busy",
      action: "runtime",
    });
  });

  it("prefers the resolution hint over the raw startup error", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readSustained(
      makeRuntime({
        running: false,
        startupError: "never opened port 6768 within 60000ms",
        startupErrorHint: "Wait a moment and click Retry.",
      })
    );

    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Headroom stopped running",
      body: "Headroom isn't running. Wait a moment and click Retry.",
      action: "runtime",
    });
  });

  it("stays quiet while a restart is still handing the port over", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    // Reachable once, so the cold-start grace is not what is suppressing it.
    await readAt(0, makeRuntime({ running: true }));
    await readSustained(
      makeRuntime({
        running: false,
        startupError: "os error 10048",
        startupErrorHint:
          "Port 6767 is still being released by the previous Headroom session. " +
          "Nothing to do: Headroom reconnects on its own within a few minutes.",
      })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire while the runtime is starting", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readSustained(makeRuntime({ running: false, starting: true }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire while the runtime is paused", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readSustained(makeRuntime({ running: false, paused: true }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire when the runtime isn't installed", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    await readSustained(makeRuntime({ installed: false, running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire while the pricing gate has bypassed the runtime", async () => {
    isVisibleMock.mockResolvedValue(false);
    installStorage();

    // Reachable first, so neither the first-boot grace nor a hard error is
    // what keeps it quiet: a gated account stops the backend on purpose.
    await readAt(0, makeRuntime({ running: true }));
    await readSustained(
      makeRuntime({ running: false, proxyReachable: false, bypassed: true })
    );

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not fire while the window is visible", async () => {
    isVisibleMock.mockResolvedValue(true);
    installStorage();

    await readAt(0, makeRuntime({ running: true }));
    await readSustained(makeRuntime({ running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not repeat within the same day", async () => {
    isVisibleMock.mockResolvedValue(false);
    const today = localDayKey(new Date());
    installStorage({ headroom_urgent_runtime_down_date: today });

    await readAt(0, makeRuntime({ running: true }));
    await readSustained(makeRuntime({ running: false }));

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("fireUpsellNudge", () => {
  const KEY = "headroom_upsell_nudge_date";

  afterEach(() => {
    vi.useRealTimers();
    invokeMock.mockReset();
  });

  it("suppresses overnight (quiet hours)", async () => {
    installStorage();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0)); // 2 AM local
    expect(await fireUpsellNudge("t", "b")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires during the day and records state", async () => {
    const store = installStorage();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(await fireUpsellNudge("Upgrade", "body")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("show_notification", {
      title: "Upgrade",
      body: "body",
      action: "billing",
    });
    expect(store.get(KEY)).toMatch(/^2026-01-15\|1\|/);
  });

  it("caps at two per local day", async () => {
    installStorage();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));
    expect(await fireUpsellNudge("t", "b")).toBe(true);
    vi.setSystemTime(new Date(2026, 0, 15, 16, 0, 0)); // +7h, past the min gap
    expect(await fireUpsellNudge("t", "b")).toBe(true);
    vi.setSystemTime(new Date(2026, 0, 15, 21, 0, 0)); // still daytime, cap hit
    expect(await fireUpsellNudge("t", "b")).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("enforces a minimum gap between nudges", async () => {
    installStorage();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));
    expect(await fireUpsellNudge("t", "b")).toBe(true);
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0)); // +3h < 6h gap
    expect(await fireUpsellNudge("t", "b")).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("fires once when two effect runs overlap", async () => {
    const store = installStorage();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    const results = await Promise.all([
      fireUpsellNudge("t", "b"),
      fireUpsellNudge("t", "b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(store.get(KEY)).toMatch(/^2026-01-15\|1\|/);
  });

  it("restores the previous state when the notification fails", async () => {
    const previous = `2026-01-14|2|${new Date(2026, 0, 14, 20, 0, 0).getTime()}`;
    const store = installStorage({ [KEY]: previous });
    invokeMock.mockRejectedValueOnce(new Error("notifications disabled"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(await fireUpsellNudge("t", "b")).toBe(false);
    expect(store.get(KEY)).toBe(previous);
  });

  it("never fires from the launcher webview", async () => {
    installStorage();
    invokeMock.mockResolvedValue(undefined);
    windows.label = "launcher";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(await fireUpsellNudge("t", "b")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resets the next local day", async () => {
    const yesterday = new Date(2026, 0, 15, 20, 0, 0).getTime();
    installStorage({ [KEY]: `2026-01-15|2|${yesterday}` });
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 16, 9, 0, 0)); // next local day
    expect(await fireUpsellNudge("t", "b")).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
