// ColorPickerState: open/close + apply-callback semantics.

import { afterEach, describe, expect, it, vi } from "vitest";
import { colorPickerState } from "./color-picker.svelte";

afterEach(() => {
  colorPickerState.close();
});

describe("colorPickerState", () => {
  it("starts with no pending request", () => {
    expect(colorPickerState.pending).toBeNull();
  });

  it("open() stores the request, close() clears it", () => {
    const anchor = {} as HTMLElement;
    colorPickerState.open({ anchor, initialHex: "#aabbccff", onApply: () => {} });
    expect(colorPickerState.pending?.initialHex).toBe("#aabbccff");
    colorPickerState.close();
    expect(colorPickerState.pending).toBeNull();
  });

  it("apply(hex) clears pending and invokes the onApply callback", () => {
    const onApply = vi.fn();
    colorPickerState.open({
      anchor: {} as HTMLElement,
      initialHex: "#000000ff",
      onApply,
    });
    colorPickerState.apply("#112233ff");
    expect(onApply).toHaveBeenCalledWith("#112233ff");
    expect(colorPickerState.pending).toBeNull();
  });

  it("apply() with no pending request is a no-op", () => {
    expect(() => colorPickerState.apply("#ffffffff")).not.toThrow();
    expect(colorPickerState.pending).toBeNull();
  });
});
