import { defineConfig, type Plugin } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import UnoCSS from "unocss/vite";
import { watch } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

// Dev-only workaround for WebKit ESM TDZ race in SvelteKit bootstrap.
// See sveltejs/kit#15287, upstream fix WebKit/WebKit#57827. When Tauri
// rebuilds Rust and relaunches the webview, the fresh Vite startup calls
// sync.all() which rewrites .svelte-kit/generated/ files; the watcher
// then streams those as HMR updates into the mid-bootstrap webview,
// triggering the TDZ race. Restarting Vite lets the new webview hit a
// clean process; ignoring .svelte-kit/generated/ in watch (below) stops
// the spurious HMR from the regeneration.
const restartOnRustChange = (): Plugin => ({
  name: "tomat-restart-on-rust-change",
  configureServer(server) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (_: unknown, filename: string | Buffer | null) => {
      if (!filename) return;
      const f = String(filename);
      if (!f.endsWith(".rs") && !f.endsWith("Cargo.toml")) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        server.config.logger.info("[tomat] rust change, restarting vite");
        server.restart();
      }, 100);
    };
    const watchers = [
      watch("src/tauri/src", { recursive: true }, onChange),
      watch("src/tauri/Cargo.toml", onChange),
    ];
    server.httpServer?.once("close", () => {
      clearTimeout(timer);
      for (const w of watchers) w.close();
    });
  },
});

export default defineConfig(async () => ({
  plugins: [UnoCSS(), sveltekit(), !host && restartOnRustChange()].filter(Boolean),

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
      // Ignore src/tauri (no reason to HMR on Rust/Cargo output) and
      // .svelte-kit/generated (svelte-kit sync regenerates these en masse,
      // which fires a burst of HMR updates that trips the WebKit ESM TDZ
      // race in client.js, see sveltejs/kit#15287). Route HMR continues
      // to work via src/ui/routes/ being watched directly; only route add /
      // delete now needs a manual refresh to pick up the new manifest.
      ignored: ["**/src/tauri/**", "**/.svelte-kit/generated/**"],
    },
  },

  // Pre-bundle deps that are unconditionally on the first-render path so
  // Vite does not stall on them during initial request discovery. marked,
  // highlight.js, and marked-highlight are intentionally excluded; they
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
