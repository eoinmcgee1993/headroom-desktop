export const PREVIEW_SUPPORT_EMAIL = "support@extraheadroom.com";

export function platformPreviewNoticeFor(
  platform: string | undefined,
  supportTier: string | undefined,
): string | null {
  if (supportTier !== "experimental") {
    return null;
  }
  if (platform === "linux") {
    return "Linux is currently in preview.";
  }
  return "This platform is currently in preview.";
}

/** Pre-filled support mail for preview-platform reports: the diagnostics we
 *  always end up asking for (platform, app build, runtime build) are already
 *  in the body so the user only has to describe what broke. */
export function platformPreviewSupportMailto(context: {
  platform: string | undefined;
  appVersion: string;
  headroomVersion: string;
}): string {
  const subject = `Headroom ${context.platform ?? "platform"} preview issue`;
  const body =
    "What happened, and what were you doing at the time?\n\n\n" +
    "---\n" +
    "Diagnostic info (please keep):\n" +
    [
      `Platform: ${context.platform ?? "unknown"}`,
      `App version: ${context.appVersion}`,
      `Headroom CLI: ${context.headroomVersion}`,
    ].join("\n");
  return `mailto:${PREVIEW_SUPPORT_EMAIL}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

const CLAUDE_CODE_INSTALL_CURL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";
const CLAUDE_CODE_INSTALL_PS_CMD = "irm https://claude.ai/install.ps1 | iex";

/** The Claude Code install one-liner for this OS. Windows has no bash, and
 *  PowerShell's `curl` alias rejects -fsSL, so it gets the PowerShell installer.
 *  Every install prompt goes through here so the prompts cannot drift apart. */
export function claudeCodeInstallCommand(platform: string | undefined): string {
  return platform === "windows" ? CLAUDE_CODE_INSTALL_PS_CMD : CLAUDE_CODE_INSTALL_CURL_CMD;
}
