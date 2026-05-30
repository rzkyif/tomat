#!/usr/bin/env -S deno run -A
// Builds the Astro site to packages/tomat-website/dist/. No idempotency
// probe, no R2 calls, no wrangler — use `deno task release:website` for the
// full deploy pipeline.

import { astroBuild } from "../release/lib.ts";

await astroBuild();
