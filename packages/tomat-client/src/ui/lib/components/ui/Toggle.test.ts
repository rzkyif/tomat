// smoke-test the Svelte 5 component path. Toggle is the smallest
// stateful leaf; if this test runs, the runes/@testing-library/svelte/jsdom
// stack is wired correctly. Most UI primitives don't get dedicated tests
// (too low ROI). This one exists to lock in the test harness.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import Toggle from "./Toggle.svelte";

describe("Toggle", () => {
  it("renders with the initial checked state", () => {
    const { container } = render(Toggle, { props: { checked: true } });
    const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(input).toBeTruthy();
    expect(input?.checked).toBe(true);
  });

  it("calls onchange with the new value when the input is toggled", async () => {
    const onchange = vi.fn();
    const { container } = render(Toggle, {
      props: { checked: false, onchange },
    });
    const input = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await fireEvent.click(input);
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it("renders an aria-label when ariaLabel prop is provided", () => {
    const { container } = render(Toggle, {
      props: { checked: false, ariaLabel: "enable-tts" },
    });
    expect(container.querySelector("input[aria-label='enable-tts']")).toBeTruthy();
  });

  it("disables the input when disabled prop is true", () => {
    const { container } = render(Toggle, {
      props: { checked: false, disabled: true },
    });
    const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(input?.disabled).toBe(true);
  });
});
