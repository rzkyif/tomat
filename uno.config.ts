import { defineConfig, presetIcons, presetTypography, presetWind4 } from "unocss";
import extractorSvelte from "@unocss/extractor-svelte";

const inversionMap: Record<string, string> = {
  "50": "900",
  "100": "800",
  "200": "700",
  "300": "600",
  "400": "500",
  "500": "400",
  "600": "400",
  "700": "300",
  "800": "200",
  "900": "100",
};

export default defineConfig({
  presets: [presetWind4({ dark: "class" }), presetIcons(), presetTypography()],
  extractors: [extractorSvelte()],
  content: {
    pipeline: {
      include: [/\.(vue|svelte|[jt]sx?|mdx?|astro|elm|php|phtml|html)($|\?)/],
    },
  },
  shortcuts: [
    [/^bg-default-(\d+)$/, ([, s]) => `bg-neutral-${s} dark:bg-neutral-${inversionMap[s] ?? s}`],
    [
      /^text-default-(\d+)$/,
      ([, s]) => `text-neutral-${s} dark:text-neutral-${inversionMap[s] ?? s}`,
    ],
    [
      /^border-default-(\d+)$/,
      ([, s]) => `border-neutral-${s} dark:border-neutral-${inversionMap[s] ?? s}`,
    ],
    [
      /^bg-default-inverted-(\d+)$/,
      ([, s]) => `bg-neutral-${inversionMap[s] ?? s} dark:bg-neutral-${s}`,
    ],
    [
      /^text-default-inverted-(\d+)$/,
      ([, s]) => `text-neutral-${inversionMap[s] ?? s} dark:text-neutral-${s}`,
    ],
    [
      /^border-default-inverted-(\d+)$/,
      ([, s]) => `border-neutral-${inversionMap[s] ?? s} dark:border-neutral-${s}`,
    ],
    [
      /^bg-accent-(blue|purple|red|green)-(\d+)$/,
      ([, c, s]) => `bg-${c}-${s} dark:bg-${c}-${inversionMap[s] ?? s}`,
    ],
    [
      /^text-accent-(blue|purple|red|green)-(\d+)$/,
      ([, c, s]) => `text-${c}-${s} dark:text-${c}-${inversionMap[s] ?? s}`,
    ],
    [
      /^border-accent-(blue|purple|red|green)-(\d+)$/,
      ([, c, s]) => `border-${c}-${s} dark:border-${c}-${inversionMap[s] ?? s}`,
    ],
    // Inner-card background, one level of lightness darker than its parent
    // bubble (`bg-default-300` / `bg-accent-X-300`), in BOTH themes. This
    // intentionally side-steps the inversion map: light goes to -400 and dark
    // goes to -700, so the card always reads as recessed against the bubble.
    [
      /^bg-card-(default|blue|purple|red|green)$/,
      ([, c]) => {
        const color = c === "default" ? "neutral" : c;
        return `bg-${color}-400 dark:bg-${color}-700`;
      },
    ],
    {
      "bg-chip-neutral": "bg-neutral-200 dark:bg-neutral-700",
      "text-chip-neutral": "text-neutral-600 dark:text-neutral-400",
      "bg-chip-blue": "bg-blue-200 dark:bg-blue-800",
      "text-chip-blue": "text-blue-700 dark:text-blue-300",
      "bg-chip-red": "bg-red-200 dark:bg-red-800",
      "text-chip-red": "text-red-700 dark:text-red-300",
      "bg-chip-amber": "bg-amber-200 dark:bg-amber-800",
      "text-chip-amber": "text-amber-700 dark:text-amber-300",
      "bg-chip-emerald": "bg-emerald-200 dark:bg-emerald-800",
      "text-chip-emerald": "text-emerald-700 dark:text-emerald-300",
      "bg-ctx-green": "bg-green-200 dark:bg-green-800",
      "bg-ctx-yellow": "bg-yellow-200 dark:bg-yellow-800",
      "bg-ctx-orange": "bg-orange-200 dark:bg-orange-800",
      "bg-ctx-red": "bg-red-200 dark:bg-red-800",
    },
  ],
});
