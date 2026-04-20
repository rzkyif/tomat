import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import UnoCSS from "unocss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [UnoCSS(), sveltekit()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  // Pre-bundle deps that are unconditionally on the first-render path so
  // Vite does not stall on them during initial request discovery. marked,
  // highlight.js, and marked-highlight are intentionally excluded — they
  // are lazy-loaded via dynamic import in MessageMarkdown.svelte.
  optimizeDeps: {
    include: [
      "dompurify",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/plugin-opener",
    ],
  },
}));
