/**
 * Hex ↔ OKLCH conversion with alpha support. Used by the bubble color
 * picker to (a) drive the OKLCHa sliders, (b) back-compute the light-mode
 * hex when the user edits in dark mode, and (c) render the dark variant
 * preview without a CSS round-trip.
 *
 * Reference: https://bottosson.github.io/posts/oklab/
 */

const DELTA_L_LIGHT_TO_DARK_BG = 0.24;

export interface Oklch {
  l: number;
  c: number;
  h: number;
  /** alpha 0..1 */
  a: number;
}

/** Accepts `#rrggbb` (alpha defaulted to 1) or `#rrggbbaa`. */
const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isValidHex(s: string): boolean {
  return HEX_RE.test(s);
}

/** Normalize any valid hex to 8-char form (`#rrggbbaa`). */
export function toEightCharHex(hex: string): string {
  if (!HEX_RE.test(hex)) throw new Error(`invalid hex: ${hex}`);
  return hex.length === 7 ? `${hex}ff` : hex.toLowerCase();
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function hexToOklch(hex: string): Oklch {
  const m = hex.match(HEX_RE);
  if (!m) throw new Error(`invalid hex: ${hex}`);
  const body = m[1];
  const r = srgbToLinear(parseInt(body.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(body.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(body.slice(4, 6), 16) / 255);
  const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;

  const lLin = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mLin = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sLin = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(lLin);
  const m_ = Math.cbrt(mLin);
  const s_ = Math.cbrt(sLin);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const aa = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.hypot(aa, bb);
  let h = (Math.atan2(bb, aa) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h, a };
}

export function oklchToHex({ l, c, h, a }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const aa = c * Math.cos(hr);
  const bb = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * aa + 0.2158037573 * bb;
  const m_ = l - 0.1055613458 * aa - 0.0638541728 * bb;
  const s_ = l - 0.0894841775 * aa - 1.291485548 * bb;

  const lLin = l_ * l_ * l_;
  const mLin = m_ * m_ * m_;
  const sLin = s_ * s_ * s_;

  const r = 4.0767416621 * lLin - 3.3077115913 * mLin + 0.2309699292 * sLin;
  const g = -1.2684380046 * lLin + 2.6097574011 * mLin - 0.3413193965 * sLin;
  const b = -0.0041960863 * lLin - 0.7034186147 * mLin + 1.707614701 * sLin;

  const toByte = (v: number): string => {
    const clamped = Math.max(0, Math.min(1, linearToSrgb(v)));
    return Math.round(clamped * 255)
      .toString(16)
      .padStart(2, "0");
  };
  const alphaByte = Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}${alphaByte}`;
}

function shiftLightness(hex: string, delta: number): string {
  const oklch = hexToOklch(hex);
  return oklchToHex({ ...oklch, l: oklch.l + delta });
}

/** Approximate the dark-mode bubble bg from the stored light-mode hex.
 *  Lightness delta matches the Tailwind 300→600 step (~-0.24); alpha is
 *  preserved. */
export function darkFromLight(lightHex: string): string {
  return shiftLightness(lightHex, -DELTA_L_LIGHT_TO_DARK_BG);
}

/** Inverse of `darkFromLight`. */
export function lightFromDark(darkHex: string): string {
  return shiftLightness(darkHex, DELTA_L_LIGHT_TO_DARK_BG);
}

/** True when the 8-char hex has any alpha at all. Per-component theme
 *  overrides use a `#......00` value to mean "inherit the global default";
 *  any other alpha means the override is active. */
export function hasAlpha(hex: string | undefined | null): boolean {
  if (typeof hex !== "string") return false;
  if (hex.length === 7) return true;
  if (hex.length !== 9) return false;
  return hex.slice(7, 9).toLowerCase() !== "00";
}
