import { getContext, setContext } from "svelte";
import { BASE_MS } from "./animations.ts";
import type { Alignment } from "./types.ts";
import { getDefaultSettings } from "../domain/settings/engine.ts";
import { hasAlpha } from "./color.ts";

// The state surface the extracted presentational components read. In the client
// a provider backs this with the live `settingsState` / `expansionState` stores
// (see lib/ui-context in the client); on the website a provider supplies static
// or demo values. A component never imports a client store directly: it calls
// `useUiContext()` and reads through this interface, so it renders identically
// in both apps and standalone (the DEFAULT_UI_CONTEXT below).
//
// Members that must stay reactive when the client mutates settings are declared
// as getters: reading `ctx.bubbleBlurRings` inside a component's `$derived`
// then tracks the underlying `$state`, because the provider's getter touches it.
//
// Every UiContext is built by `makeUiContext` (below). There is exactly one
// implementation of the settings-derived members, so the three call sites (the
// client provider, DEFAULT_UI_CONTEXT, and the website showcase) cannot drift
// the way a hand-copied object would.
export interface UiContext {
  /** The screen edge bubbles anchor to (settings.appearance alignment). */
  getAlignment(): Alignment;
  /** Whether the frosted bubble halo is on. */
  readonly bubbleBlurEnabled: boolean;
  /** How many concentric halo rings to render when blur is on. */
  readonly bubbleBlurRings: number;
  /** Optional per-system-message base color hex override (appearance setting),
   *  or undefined when no override is set. */
  readonly systemMessageDefaultColor: string | undefined;
  /** Resolve an animation duration in ms honoring the app's animation settings
   *  (master switch + speed multiplier). The static default returns base
   *  unchanged, so a standalone render animates at full BASE_MS speed. */
  animationDurationMs(baseMs?: number): number;
  /** Read shared per-id expansion state (e.g. an Expandable bubble header).
   *  `fallback` is returned when the id has no stored value yet, so a bubble
   *  that should start expanded (a tool `display`) and one that should start
   *  collapsed (a system prompt) both round-trip through the same registry. */
  expansionGet(id: string | undefined, fallback?: boolean): boolean;
  /** Write shared per-id expansion state. */
  expansionSet(id: string, value: boolean): void;
  /** Seed a per-id default ONLY if the id has no stored value yet. A bubble
   *  that opens expanded by default (a tool `display`) calls this on mount so
   *  the layout (which reads the registry raw) agrees with the body. Idempotent,
   *  so it never clobbers a user's toggle across the message-stack remounts. */
  expansionInit(id: string, value: boolean): void;
  /** The host the UI renders on. Views read this to pick layout variants; there
   *  is no web client, so the only values are the two native shells. */
  readonly platform: "desktop" | "mobile";
  /** Spacing scale for the host. `"compact"` enlarges tap targets / tightens
   *  chrome on touch shells; `"comfortable"` is the desktop default. */
  readonly density: "comfortable" | "compact";
  /** The primary pointer. `"coarse"` (touch) Views gate hover-only affordances
   *  behind `pointer === "fine"`. */
  readonly pointer: "fine" | "coarse";
}

const KEY = Symbol("tomat:ui-context");

/** The host-specific pieces a `makeUiContext` caller supplies. Only `getSetting`
 *  is required; everything else has a presentational default so a no-provider
 *  render (the website gallery, a standalone preview) still works. */
export interface UiContextSources {
  /** Read a settings value by key. Live in the client, schema-default elsewhere.
   *  The factory wraps each read in a getter, so a live store stays reactive. */
  getSetting(key: string): unknown;
  /** Resolve an animation duration honoring app settings. Default: identity. */
  animationDurationMs?: (baseMs?: number) => number;
  /** Read shared per-id expansion state. Default: return the fallback. */
  expansionGet?: (id: string | undefined, fallback?: boolean) => boolean;
  /** Write shared per-id expansion state. Default: no-op. */
  expansionSet?: (id: string, value: boolean) => void;
  /** Seed a per-id default only if absent. Default: no-op. */
  expansionInit?: (id: string, value: boolean) => void;
  platform?: "desktop" | "mobile";
  density?: "comfortable" | "compact";
  pointer?: "fine" | "coarse";
}

/** Build a `UiContext` from host-specific sources. The settings-derived members
 *  (alignment, blur, the system-message tint) are computed here ONCE, so the
 *  client provider, DEFAULT_UI_CONTEXT, and the showcase share identical logic
 *  and cannot drift. Settings reads happen inside getters, so a live store read
 *  by a consumer's `$derived` stays reactive. */
export function makeUiContext(sources: UiContextSources): UiContext {
  const { getSetting } = sources;
  return {
    getAlignment: () => (getSetting("layout.alignment") as Alignment | undefined) ?? "center",
    get bubbleBlurEnabled() {
      return getSetting("appearance.bubbleBlurEnabled") !== false;
    },
    get bubbleBlurRings() {
      return (getSetting("appearance.bubbleBlurRings") as number | undefined) ?? 1;
    },
    get systemMessageDefaultColor() {
      // A fully transparent value means "no override" (fall back to the base).
      const c = getSetting("appearance.systemMessageDefaultColor") as string | undefined;
      return hasAlpha(c) ? c : undefined;
    },
    animationDurationMs: sources.animationDurationMs ?? ((baseMs = BASE_MS) => baseMs),
    expansionGet: sources.expansionGet ?? ((_id, fallback = false) => fallback),
    expansionSet: sources.expansionSet ?? (() => {}),
    expansionInit: sources.expansionInit ?? (() => {}),
    platform: sources.platform ?? "desktop",
    density: sources.density ?? "comfortable",
    pointer: sources.pointer ?? "fine",
  };
}

/** Used when no provider is mounted: a standalone render of a single component
 *  (the website's static showcases, a Storybook-like preview). Every value is
 *  read from the settings schema's defaults via `getDefaultSettings()`, so a
 *  no-provider render matches a fresh app EXACTLY (e.g. center alignment, 1 halo
 *  ring) instead of drifting from hardcoded guesses. */
const D = getDefaultSettings();
export const DEFAULT_UI_CONTEXT: UiContext = makeUiContext({
  getSetting: (key) => D[key],
});

/** Mount a context for the subtree. Call once high in each app's tree. */
export function setUiContext(ctx: UiContext): void {
  setContext(KEY, ctx);
}

/** Read the mounted context, falling back to DEFAULT_UI_CONTEXT. */
export function useUiContext(): UiContext {
  return getContext<UiContext | undefined>(KEY) ?? DEFAULT_UI_CONTEXT;
}
