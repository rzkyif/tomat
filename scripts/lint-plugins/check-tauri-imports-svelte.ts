// Companion to the `tomat/no-tauri-import` rule in
// scripts/lint-plugins/oxlint-plugin.ts, the oxlint JS plugin that enforces the
// same rule for .ts files. oxlint doesn't parse .svelte
// files, so any @tauri-apps import inside a `<script>` block slips through.
// This grep-based pass closes that gap by walking the same tree the oxlint
// plugin protects and rejecting any direct import outside lib/platform/.
//
// Wired into `deno task lint` alongside the oxlint pass.

import { walk } from "@std/fs/walk";

const ROOT = new URL("../../packages/tomat-client/src/ui/", import.meta.url).pathname;
const ALLOW = "lib/platform/tauri.ts";
// Match either `from "@tauri-apps/..."` or `import "@tauri-apps/..."`,
// preceded by whitespace so we don't match inside string literals that
// happen to contain the substring (e.g. error messages, docstrings).
const IMPORT_RE = /(?:from\s+|import\s+)["']@tauri-apps\/[^"']+["']/;

interface Violation {
  file: string;
  lineNumber: number;
  line: string;
}

async function scan(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for await (const entry of walk(ROOT, { exts: [".svelte"], includeDirs: false })) {
    if (entry.path.endsWith(ALLOW)) continue;
    const text = await Deno.readTextFile(entry.path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (IMPORT_RE.test(lines[i])) {
        violations.push({
          file: entry.path.slice(ROOT.length - "packages/tomat-client/src/ui/".length),
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
  console.error("Direct @tauri-apps imports forbidden outside lib/platform/tauri.ts:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineNumber}  ${v.line}`);
  }
  console.error(
    "\nRoute these calls through $lib/platform/ instead. Add a method to " +
      "the Platform interface if one doesn't exist yet.",
  );
  Deno.exit(1);
}
