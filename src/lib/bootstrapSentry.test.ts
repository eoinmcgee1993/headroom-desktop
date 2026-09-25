import { describe, expect, it, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react";

import { buildBootstrapInvokeFailureReport, reportBootstrapFailure } from "./bootstrapSentry";

const mockScope = vi.hoisted(() => ({
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setFingerprint: vi.fn(),
  setContext: vi.fn(),
  setExtra: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) => cb(mockScope)),
}));

describe("bootstrap sentry helpers", () => {
  it("builds invoke failure reports from bridge errors", () => {
    const report = buildBootstrapInvokeFailureReport(new Error("Bootstrap is already running."));

    expect(report).toEqual({
      source: "invoke_error",
      phase: "command_dispatch",
      message: "Bootstrap is already running.",
      currentStep: "Install failed",
      overallPercent: 1,
      currentStepEtaSeconds: 0,
    });
  });

});

describe("reportBootstrapFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls withScope and captureException", () => {
    const report = buildBootstrapInvokeFailureReport(new Error("Installation failed: disk full"));

    reportBootstrapFailure(report);

    expect(Sentry.withScope).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const err = vi.mocked(Sentry.captureException).mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BootstrapFailedError");
    expect(err.message).toBe("Installation failed: disk full");
  });

  it("includes cause as extra when provided", () => {
    const report = buildBootstrapInvokeFailureReport(new Error("Installation failed: disk full"));

    reportBootstrapFailure(report, new Error("underlying cause"));

    expect(mockScope.setExtra).toHaveBeenCalledWith("cause", expect.any(String));
  });

  it("does not set extra when cause is not provided", () => {
    const report = buildBootstrapInvokeFailureReport(new Error("Installation failed: disk full"));

    reportBootstrapFailure(report);

    expect(mockScope.setExtra).not.toHaveBeenCalled();
  });
});
