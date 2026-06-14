// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    files: {
      lib: "src/ui/lib",
      routes: "src/ui/routes",
      appTemplate: "src/ui/app.html",
    },
    alias: {
      "@tomat/shared": "../tomat-shared/src/index.ts",
      "@tomat/shared/*": "../tomat-shared/src/*",
      // Svelte / runes side lives at the top of src/ui (not under lib, which
      // is reserved for pure-TS domain libraries). `$state` is avoided as an
      // alias because it collides with the Svelte 5 `$state` rune, so the
      // state folder is aliased as `$stores`.
      $components: "src/ui/components",
      "$components/*": "src/ui/components/*",
      $composables: "src/ui/composables",
      "$composables/*": "src/ui/composables/*",
      $stores: "src/ui/state",
      "$stores/*": "src/ui/state/*",
    },
  },
};

export default config;
