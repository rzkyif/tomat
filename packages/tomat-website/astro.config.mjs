import { defineConfig } from "astro/config";

// Pure-static site. No SSR adapter needed. Wrangler's static-assets
// feature (configured in wrangler.toml) serves `./dist/` directly when
// deployed to Cloudflare Workers. If we ever add SSR endpoints, install
// @astrojs/cloudflare and pass `adapter: cloudflare()` here.
export default defineConfig({
  site: "https://au.tomat.ing",
  output: "static",
  trailingSlash: "ignore",
  build: {
    assets: "_astro",
  },
});
