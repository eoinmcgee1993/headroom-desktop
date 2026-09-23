import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ClaudeStatuslinePanel } from "./ClaudeStatuslinePanel";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

describe("ClaudeStatuslinePanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("toggles the status line off and back on through the backend", async () => {
    let enabled = true;
    invokeMock.mockImplementation((command: string, args?: { enabled: boolean }) => {
      if (command === "get_claude_statusline_enabled") return Promise.resolve(enabled);
      if (command === "set_claude_statusline_enabled") {
        enabled = args!.enabled;
        return Promise.resolve(enabled);
      }
      throw new Error(`unexpected command ${command}`);
    });
    render(<ClaudeStatuslinePanel />);

    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(invokeMock).toHaveBeenCalledWith("set_claude_statusline_enabled", { enabled: false });

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(invokeMock).toHaveBeenLastCalledWith("set_claude_statusline_enabled", { enabled: true });
  });

  it("keeps the last known state when saving fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) =>
      command === "get_claude_statusline_enabled"
        ? Promise.resolve(true)
        : Promise.reject(new Error("settings.json unreadable"))
    );
    render(<ClaudeStatuslinePanel />);

    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
