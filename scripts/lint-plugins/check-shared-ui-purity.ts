// Purity check for the shared UI layer (Tier A0 primitives + Tier A `*View`s).
// A shared component must have no expectations from its host: it may not import
// client code (`@tomat/client`, the `$lib`/`$stores`/`$composables` aliases),
// `@tauri-apps/*`, or the API/network layer (`@tomat/shared/api/*`). Network and
// platform access is impossible transitively once client imports are banned, so
// a presentational View renders identically in the client, the website, and a
// future mobile build. See packages/tomat-shared/src/ui/README.md.
//
// Companion to the oxlint `tomat/no-tauri-import` family (oxlint can't parse
// .svelte). Wired into `deno task lint`.
//
// Phase 0 ships this in warn mode; Phase 6 flips STRICT to fail the build.

import { walk } from "@std/fs/walk";
import { fromFileUrl } from "@std/path";

const STRICT = true;
// Native OS path (fromFileUrl); URL .pathname breaks walk()/readdir on Windows.
const ROOT = fromFileUrl(
  new URL("../../packages/tomat-shared/src/ui/components/", import.meta.url),
);
const REL = "packages/tomat-shared/src/ui/components/";
// Forbidden import sources for a shared presentational component.
const FORBIDDEN =
  /(?:from\s+|import\s+)["'](?:@tomat\/client|\$lib|\$stores|\$composables|@tauri-apps\/|@tomat\/shared\/api)/;

interface Violation {
  file: string;
  lineNumber: number;
  line: string;
}

async function scan(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for await (const entry of walk(ROOT, { exts: [".svelte"], includeDirs: false })) {
    const text = await Deno.readTextFile(entry.path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (FORBIDDEN.test(lines[i])) {
        violations.push({
          file: REL + entry.path.slice(ROOT.length).replaceAll("\\", "/"),
          lineNumber: i + 1,
          line: lines[i].trim(),
        });
      }
    }
  }
  return violations;
}

const violations = await scan();
if (violations.length > 0) {
  const label = STRICT ? "ERROR" : "WARN";
  console.error(`[${label}] shared UI components must not import client/tauri/api code:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineNumber}  ${v.line}`);
  }
  console.error(
    "\nInject client-only behavior via props/callbacks/snippets instead; keep the View presentational.",
  );
  if (STRICT) Deno.exit(1);
}
