import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CrashFallback } from "./CrashFallback";

describe("CrashFallback", () => {
  it("clears the boot overlay so a launch-time crash shows its Reload button", () => {
    const bootComplete = vi.fn();
    window.addEventListener("headroom:boot-complete", bootComplete);
    try {
      render(<CrashFallback />);
    } finally {
      window.removeEventListener("headroom:boot-complete", bootComplete);
    }

    expect(bootComplete).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
