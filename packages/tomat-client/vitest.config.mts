import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

// Vitest config for the Svelte 5 UI. Kept separate from vite.config.ts
// because vitest only needs the Svelte plugin (no SvelteKit, no UnoCSS,
// no Tauri-restart watcher), and pulling in SvelteKit's plugin under
// vitest pulls in the $app/* virtual modules which we mock instead.
//
// Tests live next to their source files as `*.test.ts`. The `.tmp.test.ts`
// variant is gitignored agent-scratch tests; both globs are picked up.

export default defineConfig({
  // Bare svelte plugin. `hot: false` is not a valid plugin option, and
  // the plugin's configureServer hook tries to wire HMR even when vitest
  // doesn't want it; `server.hmr: false` below short-circuits that path.
  // autoCleanup is wired manually in src/ui/test-setup.ts because
  // svelteTesting()'s default cleanup setup file lives under
  // node_modules/.deno/... where Vite's loader can't resolve it.
  plugins: [svelte(), svelteTesting({ autoCleanup: false })],
  resolve: {
    alias: {
      "@tomat/shared": new URL("../tomat-shared/src/index.ts", import.meta.url).pathname,
      // SvelteKit's `$lib` alias is supplied here for vitest since we don't
      // load the SvelteKit plugin (see top-of-file comment).
      $lib: new URL("./src/ui/lib", import.meta.url).pathname,
      // SvelteKit virtual modules. We don't run SvelteKit under vitest, so
      // these point at tiny shim files that export the same surface.
      "$app/environment": new URL("./src/ui/test-shims/app-environment.ts", import.meta.url)
        .pathname,
    },
  },
  server: { hmr: false },
  test: {
    environment: "jsdom",
    include: ["src/ui/**/*.test.ts"],
    setupFiles: ["./src/ui/test-setup.ts"],
    globals: false,
    // Run the suite serially per file. Svelte 5 runes share a hidden
    // global effect-tracking context, and parallel runs in jsdom can
    // produce flaky teardown order. Drop this once we have a real
    // motivating reason for parallelism.
    pool: "forks",
    fileParallelism: false,
  },
});
