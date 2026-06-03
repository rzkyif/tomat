import { defineConfig, presetIcons, presetTypography, presetWind4 } from "unocss";
import extractorSvelte from "@unocss/extractor-svelte";

export default defineConfig({
  presets: [presetWind4({ dark: "class" }), presetIcons(), presetTypography()],
  // Route font-sans/font-mono through the runtime-overridable CSS variables
  // declared in app.css and written by the appearance.{default,mono}Font
  // settings (see +page.svelte).
  theme: {
    font: {
      sans: "var(--font-default)",
      mono: "var(--font-mono)",
    },
  },
  extractors: [extractorSvelte()],
  content: {
    pipeline: {
      include: [/\.(vue|svelte|[jt]sx?|mdx?|astro|elm|php|phtml|html)($|\?)/],
    },
  },
  shortcuts: [
    // The themable color tokens. Each `*-default-*` and `*-accent-*-*` class
    // resolves to a CSS variable defined in app.css; those variables are
    // derived from a single user-customizable base hex per scope via
    // `oklch(from var(--<scope>-base) <L> c h / alpha)`. See app.css for the
    // light/dark L tables and the per-scope variable declarations.
    [/^bg-default-(\d+)$/, ([, s]) => `bg-[var(--default-${s})] dark:bg-[var(--default-d-${s})]`],
    [
      /^text-default-(\d+)$/,
      ([, s]) => `text-[var(--default-${s})] dark:text-[var(--default-d-${s})]`,
    ],
    [
      /^border-default-(\d+)$/,
      ([, s]) => `border-[var(--default-${s})] dark:border-[var(--default-d-${s})]`,
    ],
    [
      /^bg-default-inverted-(\d+)$/,
      ([, s]) => `bg-[var(--default-d-${s})] dark:bg-[var(--default-${s})]`,
    ],
    [
      /^text-default-inverted-(\d+)$/,
      ([, s]) => `text-[var(--default-d-${s})] dark:text-[var(--default-${s})]`,
    ],
    [
      /^border-default-inverted-(\d+)$/,
      ([, s]) => `border-[var(--default-d-${s})] dark:border-[var(--default-${s})]`,
    ],
    [
      /^from-default-(\d+)$/,
      ([, s]) => `from-[var(--default-${s})] dark:from-[var(--default-d-${s})]`,
    ],
    [/^to-default-(\d+)$/, ([, s]) => `to-[var(--default-${s})] dark:to-[var(--default-d-${s})]`],
    [
      /^via-default-(\d+)$/,
      ([, s]) => `via-[var(--default-${s})] dark:via-[var(--default-d-${s})]`,
    ],
    [
      /^bg-accent-(blue|purple|red|green|yellow)-(\d+)$/,
      ([, c, s]) => `bg-[var(--accent-${c}-${s})] dark:bg-[var(--accent-${c}-d-${s})]`,
    ],
    [
      /^text-accent-(blue|purple|red|green|yellow)-(\d+)$/,
      ([, c, s]) => `text-[var(--accent-${c}-${s})] dark:text-[var(--accent-${c}-d-${s})]`,
    ],
    [
      /^border-accent-(blue|purple|red|green|yellow)-(\d+)$/,
      ([, c, s]) => `border-[var(--accent-${c}-${s})] dark:border-[var(--accent-${c}-d-${s})]`,
    ],
    // Semantic surface tokens: the single source of truth for what shade a
    // panel vs an on-panel well/control paints. Each expands to a `*-default-N`
    // shortcut above, so dark-mode inversion and per-component `--default-base`
    // theming carry through for free. The flat surface model is one `surface`
    // for every panel/card/bubble/modal/popover, one `inset` for wells and
    // filled controls, and a deeper `inset-strong` reserved for the few
    // multi-shade controls (toggles, segmented control, a neutral chip sitting
    // on an inset row). Pure indicators (slider track/thumb, segmented
    // selected fill) intentionally keep raw `bg-default-400/500`.
    ["bg-surface", "bg-default-50"],
    ["bg-surface-inset", "bg-default-200"],
    ["bg-surface-inset-strong", "bg-default-300"],
    ["border-surface", "border-default-200"],
  ],
  rules: [
    // Three customizable roundedness buckets driven by
    // `--rounded-{small,medium,large}` CSS variables (defaults set in
    // app.css, runtime values applied in +page.svelte from the
    // appearance.rounded* settings). The class names are intentionally
    // unique (small/medium/large rather than md/lg/xl) so they don't
    // collide with UnoCSS's preset rounded utilities. Other rounded
    // utilities (rounded-sm, rounded-full, etc.) are left to the preset.
    [/^rounded-small$/, () => ({ "border-radius": "var(--rounded-small)" })],
    [/^rounded-medium$/, () => ({ "border-radius": "var(--rounded-medium)" })],
    [/^rounded-large$/, () => ({ "border-radius": "var(--rounded-large)" })],
    [
      /^rounded-l-small$/,
      () => ({
        "border-top-left-radius": "var(--rounded-small)",
        "border-bottom-left-radius": "var(--rounded-small)",
      }),
    ],
    [
      /^rounded-r-small$/,
      () => ({
        "border-top-right-radius": "var(--rounded-small)",
        "border-bottom-right-radius": "var(--rounded-small)",
      }),
    ],
  ],
});
