// Coverage check for shared `*View` components. Every View must:
//   1. have named samples in @tomat/shared/ui/samples (the SAMPLES registry),
//   2. be rendered by the website component gallery, and
//   3. be wrapped by at least one client component (the single-source rule:
//      a View only the website uses is a re-implementation in disguise).
// See packages/tomat-shared/src/ui/README.md and packages/tomat-website/AGENTS.md.
//
// Wired into `deno task lint`. Phase 0 ships this in warn mode; Phase 6 flips
// STRICT to fail the build.

import { walk } from "@std/fs/walk";

const STRICT = true;
const ROOT = new URL("../../", import.meta.url).pathname;
const VIEWS_DIR = `${ROOT}packages/tomat-shared/src/ui/components/`;
const SAMPLES_INDEX = `${ROOT}packages/tomat-shared/src/ui/samples/index.ts`;
const GALLERY = `${ROOT}packages/tomat-website/src/components/gallery/Gallery.svelte`;
const CLIENT_COMPONENTS = `${ROOT}packages/tomat-client/src/ui/components/`;

async function viewNames(): Promise<string[]> {
  const names: string[] = [];
  // Walk recursively: Views live in domain subfolders (chat/messages, settings,
  // ...), so match on the file's basename, not its subfolder path.
  for await (const e of walk(VIEWS_DIR, { exts: [".svelte"], includeDirs: false })) {
    const base = e.name.replace(/\.svelte$/, "");
    if (base.endsWith("View")) names.push(base);
  }
  return names.sort();
}

async function read(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function concat(dir: string, skip?: (p: string) => boolean): Promise<string> {
  let all = "";
  for await (const e of walk(dir, { exts: [".svelte"], includeDirs: false })) {
    if (skip?.(e.path)) continue;
    all += await Deno.readTextFile(e.path);
  }
  return all;
}

const [views, samplesSrc, gallerySrc, clientSrc, sharedSrc] = await Promise.all([
  viewNames(),
  read(SAMPLES_INDEX),
  read(GALLERY),
  concat(CLIENT_COMPONENTS),
  concat(VIEWS_DIR),
]);

const problems: string[] = [];
for (const v of views) {
  // SAMPLES registry key, e.g. `  FooView: fooSamples,`
  if (!new RegExp(`\\b${v}:\\s`).test(samplesSrc)) {
    problems.push(`${v}: no samples in @tomat/shared/ui/samples (add to SAMPLES)`);
  }
  if (!gallerySrc.includes(v)) {
    problems.push(`${v}: not rendered by the website gallery (Gallery.svelte)`);
  }
  // Covered if a client component wraps it directly, or another shared View
  // composes it (so it still ships to the client transitively). A View that is
  // neither is website-only: the single-source drift risk AGENTS.md warns about.
  // Anchor on a path boundary (`/`, quote) before the name so a longer View
  // name that contains a shorter one as a substring can't false-match.
  const ref = new RegExp(`[/"']${v}\\.svelte`);
  if (!ref.test(clientSrc) && !ref.test(sharedSrc)) {
    problems.push(
      `${v}: no client component wraps it and no shared View composes it (single-source rule)`,
    );
  }
}

if (problems.length > 0) {
  const label = STRICT ? "ERROR" : "WARN";
  console.error(`[${label}] shared View coverage gaps:`);
  for (const p of problems) console.error(`  ${p}`);
  if (STRICT) Deno.exit(1);
}
