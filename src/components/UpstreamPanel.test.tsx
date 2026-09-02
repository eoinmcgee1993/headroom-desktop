import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UpstreamPanel } from "./UpstreamPanel";
import type { UpstreamOverrideView } from "../lib/types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

const providers = [
  {
    id: "glm",
    label: "GLM (Z.ai)",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: "glm-5.3[1m]"
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    model: "kimi-k3[1m]"
  }
];

const off: UpstreamOverrideView = {
  mode: "off",
  baseUrl: "",
  hasToken: false,
  provider: "",
  model: "",
  contextWindow: "",
  providers
};
const configured: UpstreamOverrideView = {
  mode: "override",
  baseUrl: "https://api.z.ai/api/anthropic",
  hasToken: true,
  provider: "glm",
  model: "glm-5.3[1m]",
  contextWindow: "1000000",
  providers
};

function respond(current: UpstreamOverrideView, saved?: UpstreamOverrideView) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "get_upstream_override") return Promise.resolve(current);
    if (command === "save_upstream_override") return Promise.resolve(saved ?? current);
    throw new Error(`unexpected command ${command}`);
  });
}

describe("UpstreamPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  /// The whole point of the dropdown: a preset needs a token and nothing else,
  /// and the URL and model ids come from the backend that writes them.
  it("sends the picked preset and a token, and restarts onto it", async () => {
    respond(off, configured);
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await screen.findByLabelText("Provider");
    await user.selectOptions(screen.getByLabelText("Provider"), "glm");
    await user.type(screen.getByLabelText("Provider auth token"), "secret-token");
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_upstream_override", {
        mode: "override",
        provider: "glm",
        baseUrl: "",
        token: "secret-token",
        model: "",
        contextWindow: ""
      });
    });
    expect(await screen.findByText(/restarted on this provider/)).toBeInTheDocument();
  });

  /// A preset asks for a token and nothing else -- the fields it fills in for
  /// the user must not be on screen.
  it("hides the URL and model fields behind a preset", async () => {
    respond(configured);
    render(<UpstreamPanel />);

    await screen.findByLabelText("Provider auth token");
    expect(screen.queryByLabelText("Provider base URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider model")).not.toBeInTheDocument();
    expect(screen.getByText(/glm-5.3\[1m\]/)).toBeInTheDocument();
  });

  /// The token field starts blank even when one is stored, so an untouched
  /// save must not be read as "clear it".
  it("leaves a stored token alone when the field is untouched", async () => {
    respond(configured);
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText("Provider auth token")).toHaveAttribute(
        "placeholder",
        "Stored — type to replace"
      );
    });
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_upstream_override", {
        mode: "override",
        provider: "glm",
        baseUrl: "https://api.z.ai/api/anthropic",
        token: null,
        model: "glm-5.3[1m]",
        contextWindow: "1000000"
      });
    });
  });

  it("clears the stored token on request", async () => {
    respond(configured, { ...configured, hasToken: false });
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await screen.findByRole("button", { name: "Remove stored token" });
    await user.click(screen.getByRole("button", { name: "Remove stored token" }));
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_upstream_override",
        expect.objectContaining({ provider: "glm", token: "" })
      );
    });
  });

  /// An endpoint the presets do not cover still has to be reachable, with its
  /// own model id -- otherwise a stale preset would be a dead end.
  it("takes a hand-entered endpoint under Other", async () => {
    respond(off, { ...configured, provider: "", model: "custom-model" });
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await screen.findByLabelText("Provider");
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    await user.type(screen.getByLabelText("Provider base URL"), "https://api.example.com/anthropic");
    await user.type(screen.getByLabelText("Provider model"), "custom-model");
    await user.type(screen.getByLabelText("Provider context window"), "200000");
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_upstream_override", {
        mode: "override",
        provider: "",
        baseUrl: "https://api.example.com/anthropic",
        token: null,
        model: "custom-model",
        contextWindow: "200000"
      });
    });
  });

  it("surfaces a rejected base URL instead of pretending it saved", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_upstream_override") return Promise.resolve(off);
      return Promise.reject("The base URL must start with http:// or https://");
    });
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await screen.findByLabelText("Provider");
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    await user.type(screen.getByLabelText("Provider base URL"), "api.z.ai");
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    expect(await screen.findByText(/must start with http/)).toBeInTheDocument();
    expect(screen.queryByText(/restarted/)).not.toBeInTheDocument();
  });

  /// Picking Anthropic is the only way back off, so it has to reach the backend
  /// as "off" -- that is what drops the stored token and model ids too.
  it("turns the provider off when Anthropic is picked", async () => {
    respond(configured, off);
    const user = userEvent.setup();
    render(<UpstreamPanel />);

    await screen.findByLabelText("Provider");
    await user.selectOptions(screen.getByLabelText("Provider"), "");
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_upstream_override",
        expect.objectContaining({ mode: "off", provider: "" })
      );
    });
    expect(await screen.findByText(/restarted on Anthropic/)).toBeInTheDocument();
  });
});
