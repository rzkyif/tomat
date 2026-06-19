// Tier-manifest check. Every client component under src/ui/components/ must be
// classified exactly once in components/.tiers.json (tier A0/A/B/C). A Tier B
// entry must name the single shared `*View` it wraps, and that View must exist.
// This keeps the component taxonomy honest as the migration proceeds. See
// packages/tomat-shared/src/ui/README.md.
//
// Wired into `deno task lint`. Phase 0 ships this in warn mode; Phase 6 flips
// STRICT to fail the build.

import { walk } from "@std/fs/walk";

const STRICT = true;
const ROOT = new URL("../../", import.meta.url).pathname;
const COMPONENTS = `${ROOT}packages/tomat-client/src/ui/components/`;
const MANIFEST = `${COMPONENTS}.tiers.json`;
const SHARED_COMPONENTS = `${ROOT}packages/tomat-shared/src/ui/components/`;

type Entry = { tier: "A0" | "A" | "B" | "C"; wraps?: string; unsharedLeaves?: string[] };
const manifest: { components: Record<string, Entry> } = JSON.parse(
  await Deno.readTextFile(MANIFEST),
);

const onDisk = new Set<string>();
for await (const e of walk(COMPONENTS, { exts: [".svelte"], includeDirs: false })) {
  if (e.path.endsWith(".test.svelte")) continue;
  onDisk.add(e.path.slice(COMPONENTS.length));
}

// Shared `*View` basenames, found recursively (Views live in domain subfolders),
// so a Tier-B `wraps` target resolves by name regardless of which subfolder it
// moved into.
const sharedViews = new Set<string>();
for await (const e of walk(SHARED_COMPONENTS, { exts: [".svelte"], includeDirs: false })) {
  sharedViews.add(e.name.replace(/\.svelte$/, ""));
}

const listed = new Set(Object.keys(manifest.components));
const problems: string[] = [];

for (const f of onDisk) {
  if (!listed.has(f)) problems.push(`${f}: on disk but missing from .tiers.json`);
}
for (const f of listed) {
  if (!onDisk.has(f)) problems.push(`${f}: in .tiers.json but no such file`);
}
for (const [f, entry] of Object.entries(manifest.components)) {
  if (entry.tier === "B") {
    if (!entry.wraps) {
      problems.push(`${f}: tier B must set "wraps" (the View it wraps)`);
    } else if (!sharedViews.has(entry.wraps)) {
      problems.push(
        `${f}: wraps "${entry.wraps}" but no @tomat/shared/ui/components/**/${entry.wraps}.svelte exists`,
      );
    }
  }
  // A Tier-C shell may declare raw styled leaves it owns; each must be a real
  // file (path relative to the client components dir) so a stale entry fails.
  for (const leaf of entry.unsharedLeaves ?? []) {
    if (!onDisk.has(leaf)) {
      problems.push(`${f}: unsharedLeaves entry "${leaf}" is not a client component file`);
    }
  }
}

if (problems.length > 0) {
  const label = STRICT ? "ERROR" : "WARN";
  console.error(`[${label}] component-tier manifest issues:`);
  for (const p of problems) console.error(`  ${p}`);
  if (STRICT) Deno.exit(1);
}
