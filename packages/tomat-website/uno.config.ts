import { defineConfig } from "unocss";
// Relative path (not the @tomat/shared alias): uno.config.ts is loaded by
// UnoCSS via jiti, outside Vite/Astro resolution, so the alias is unavailable
// here. Same shared preset the client spreads, for an identical design system.
import { tomatUnoBase } from "../tomat-shared/src/ui/uno-preset.ts";

export default defineConfig({
  ...tomatUnoBase(),
  content: {
    pipeline: {
      include: [
        // This site's own source.
        /\.(astro|svelte|[jt]sx?|mdx?|html)($|\?)/,
        // The extracted shared components, so their utility classes are
        // generated in the website build too.
        /tomat-shared\/src\/ui\/.*\.svelte($|\?)/,
      ],
    },
  },
});
