import * as Sentry from "@sentry/react";

import { describeInvokeError } from "./appHelpers";

// Only a failed `start_bootstrap` invoke is reported from here. A failure the
// backend reaches (progress.failed) is captured by Rust's
// `capture_bootstrap_failure`, which carries the pip stderr, a per-cause
// fingerprint, the 24h per-machine dedupe and the ENOSPC filter. Re-reporting
// it here filed every cause under one fingerprint that bypassed both filters,
// so RUST-GR regressed on any new cause and could never stay resolved.
export type BootstrapFailurePhase = "command_dispatch";

export type BootstrapFailureSource = "invoke_error";

export interface BootstrapFailureReport {
  source: BootstrapFailureSource;
  phase: BootstrapFailurePhase;
  message: string;
  currentStep: string;
  overallPercent: number;
  currentStepEtaSeconds: number;
}

export function buildBootstrapInvokeFailureReport(error: unknown): BootstrapFailureReport {
  return {
    source: "invoke_error",
    phase: "command_dispatch",
    message: describeInvokeError(error, "Could not start Headroom install."),
    currentStep: "Install failed",
    overallPercent: 1,
    currentStepEtaSeconds: 0,
  };
}

export function bootstrapFailureSignature(report: BootstrapFailureReport): string {
  return [
    report.source,
    report.phase,
    report.currentStep,
    report.message,
    String(report.overallPercent),
    String(report.currentStepEtaSeconds),
  ].join("|");
}

export function reportBootstrapFailure(report: BootstrapFailureReport, cause?: unknown) {
  const error = new Error(report.message);
  error.name = "BootstrapFailedError";

  Sentry.withScope((scope) => {
    scope.setLevel("error");
    scope.setTag("flow", "bootstrap");
    scope.setTag("bootstrap_phase", report.phase);
    scope.setTag("bootstrap_source", report.source);
    scope.setFingerprint(["bootstrap_failed", report.phase, report.source]);
    scope.setContext("bootstrap", {
      currentStep: report.currentStep,
      overallPercent: report.overallPercent,
      currentStepEtaSeconds: report.currentStepEtaSeconds,
    });

    if (cause !== undefined) {
      scope.setExtra("cause", describeInvokeError(cause, report.message));
    }

    Sentry.captureException(error);
  });
}
