// hex <-> OKLCH round-trip + light/dark variant math. Pure number
// crunching; no DOM, no Tauri.

import { describe, expect, it } from "vitest";
import {
  darkFromLight,
  hasAlpha,
  hexToOklch,
  isValidHex,
  lightFromDark,
  oklchToHex,
  toEightCharHex,
} from "./color";

describe("isValidHex", () => {
  it("accepts 6-char and 8-char hex", () => {
    expect(isValidHex("#abcdef")).toBe(true);
    expect(isValidHex("#ABCDEF")).toBe(true);
    expect(isValidHex("#abcdef12")).toBe(true);
  });
  it("rejects other lengths and non-hex characters", () => {
    expect(isValidHex("#abc")).toBe(false);
    expect(isValidHex("abcdef")).toBe(false);
    expect(isValidHex("#abcdeg")).toBe(false);
    expect(isValidHex("#abcdef1")).toBe(false);
  });
});

describe("toEightCharHex", () => {
  it("pads 6-char hex with ff alpha", () => {
    expect(toEightCharHex("#aabbcc")).toBe("#aabbccff");
  });
  it("lowercases 8-char hex", () => {
    expect(toEightCharHex("#AABBCC11")).toBe("#aabbcc11");
  });
  it("throws on invalid hex", () => {
    expect(() => toEightCharHex("not-a-hex")).toThrow(/invalid hex/);
  });
});

describe("hexToOklch + oklchToHex", () => {
  it("round-trips primary colors within 1 byte per channel", () => {
    for (const hex of ["#000000ff", "#ffffffff", "#ff0000ff", "#00ff00ff", "#0000ffff"]) {
      const ok = hexToOklch(hex);
      const back = oklchToHex(ok);
      // Each channel within tolerance of the original.
      for (let i = 1; i < hex.length; i += 2) {
        const orig = parseInt(hex.slice(i, i + 2), 16);
        const round = parseInt(back.slice(i, i + 2), 16);
        expect(Math.abs(orig - round)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("preserves alpha through the round-trip", () => {
    const hex = "#aabbcc44";
    const ok = hexToOklch(hex);
    expect(ok.a).toBeCloseTo(0x44 / 255, 4);
    const back = oklchToHex(ok);
    expect(back.slice(7, 9)).toBe("44");
  });
});

describe("darkFromLight / lightFromDark", () => {
  it("inverse functions roughly cancel out", () => {
    const start = "#5577aa";
    const dark = darkFromLight(start);
    const back = lightFromDark(dark);
    // Allow 4-byte tolerance per channel for OKLCH round-trip jitter.
    for (let i = 1; i < 7; i += 2) {
      const a = parseInt(start.slice(i, i + 2), 16);
      const b = parseInt(back.slice(i, i + 2), 16);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(4);
    }
  });
});

describe("hasAlpha", () => {
  it("is true for 7-char hex (no alpha byte, defaults to opaque)", () => {
    expect(hasAlpha("#aabbcc")).toBe(true);
  });
  it("is false for 8-char hex with #..00 (sentinel for inherit)", () => {
    expect(hasAlpha("#aabbcc00")).toBe(false);
  });
  it("is true for 8-char hex with any non-zero alpha", () => {
    expect(hasAlpha("#aabbcc01")).toBe(true);
    expect(hasAlpha("#aabbccff")).toBe(true);
  });
  it("is false for missing / non-string input and wrong-length strings", () => {
    // `hasAlpha` is permissive about content: it only inspects length
    // and the trailing two characters. We cover the explicit non-string
    // and the length-mismatch branches; 7- or 9-char strings are
    // treated as a 7-char hex (opaque) or 9-char hex (alpha-bearing)
    // by design.
    expect(hasAlpha(undefined)).toBe(false);
    expect(hasAlpha(null)).toBe(false);
    // length 10: neither 7 nor 9 → false branch.
    expect(hasAlpha("0123456789")).toBe(false);
  });
});
