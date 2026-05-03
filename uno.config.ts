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
      /^bg-accent-(blue|purple|red|green|orange|yellow)-(\d+)$/,
      ([, c, s]) => `bg-${c}-${s} dark:bg-${c}-${inversionMap[s] ?? s}`,
    ],
    [
      /^text-accent-(blue|purple|red|green|orange|yellow)-(\d+)$/,
      ([, c, s]) => `text-${c}-${s} dark:text-${c}-${inversionMap[s] ?? s}`,
    ],
    [
      /^border-accent-(blue|purple|red|green|orange|yellow)-(\d+)$/,
      ([, c, s]) => `border-${c}-${s} dark:border-${c}-${inversionMap[s] ?? s}`,
    ],
  ],
});
