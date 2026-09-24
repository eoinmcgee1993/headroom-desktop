import path from "node:path";
import { describe, expect, it } from "vitest";

// The extension ships as plain CommonJS; its pure helpers are tested here and
// `activate` (which needs the vscode API) is exercised in a real editor.
import ext from "./extension.cjs";

const { fmt, pickSession, projectDirs, projectSlug, view } = ext;

describe("vscode status bar extension", () => {
  it("rounds like the terminal statusline", () => {
    expect([700, 3067, 15400, 999499, 999500, 1100000].map(fmt)).toEqual([
      "700",
      "3.1k",
      "15k",
      "999k",
      "1M",
      "1.1M"
    ]);
  });

  it("finds this workspace's transcript folders the way Claude Code names them", () => {
    expect(projectSlug("/Users/garm/Code/headroom-desktop")).toBe(
      "-Users-garm-Code-headroom-desktop"
    );
    const long = `/Users/garm/${"x".repeat(250)}`;
    const truncated = `${projectSlug(long).slice(0, 200)}-abc123`;
    // path.join, like the extension: Windows separators are `\`.
    expect(projectDirs("/p", ["/a/b", long], () => [truncated, "other"])).toEqual([
      path.join("/p", "-a-b"),
      path.join("/p", truncated)
    ]);
  });

  it("follows the workspace's most recently active conversation", () => {
    const sessions = {
      mine_old: { tokensSaved: 10, lastSavedAtMs: 100, lastRequestAtMs: 100 },
      mine_new: { tokensSaved: 20, lastSavedAtMs: 50, lastRequestAtMs: 300 },
      elsewhere: { tokensSaved: 30, lastSavedAtMs: 900, lastRequestAtMs: 900 }
    };
    expect(pickSession(sessions, (id: string) => id.startsWith("mine"))?.tokensSaved).toBe(20);
    expect(pickSession(sessions, () => false)).toBeNull();
  });

  it("flashes a new saving, then compressing, then the total, else hides", () => {
    const now = 1_000_000;
    const session = (lastSavedAtMs: number, lastRequestAtMs: number, tokensSaved = 31_000) => ({
      tokensSaved,
      lastSaved: 3_600,
      lastSavedAtMs,
      lastRequestAtMs
    });
    expect(view(session(now - 1_000, now), now)).toEqual({
      text: "$(zap) Headroom saved 31k (+3.6k)",
      highlight: true
    });
    expect(view(session(now - 60_000, now - 500), now)?.text).toBe(
      "$(sync~spin) Headroom compressing"
    );
    expect(view(session(now - 60_000, now - 60_000), now)).toEqual({
      text: "$(zap) Headroom saved 31k",
      highlight: false
    });
    expect(view(session(0, now - 60_000, 0), now)).toBeNull();
    expect(view(null, now)).toBeNull();
  });
});
