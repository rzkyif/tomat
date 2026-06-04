// Companion to the `tomat/no-uppercase-tomat` rule in
// scripts/lint-plugins/oxlint-plugin.ts, the oxlint JS plugin that enforces the
// same rule for the JS/TS file types oxlint parses. oxlint never sees Markdown,
// Rust, toml, json, yml, css, or shell scripts, so a capital-initial brand word
// in those files slips through. This pass closes that gap by walking every
// other tracked file and rejecting it wherever it appears: code, comments,
// strings, or prose.
//
// Unlike the em-dash pass, this pass also owns .svelte: oxlint's raw-text scan
// reaches a .svelte <script> block but not its template markup, where the brand
// most often appears (e.g. <h1>Welcome to tomat</h1>). So the oxlint rule is
// turned off for .svelte (override in .oxlintrc.json) and this walker is the
// sole authority for .svelte, covering both script and template.
//
// The brand is always lowercase. The all-caps TOMAT_ env-var prefix and the
// lowercase brand are both fine; only the mixed-case (capital initial) form is
// rejected. The needle is built by concatenation so this file never trips its
// own rule.
//
// Wired into `deno task lint` alongside the oxlint pass, the .svelte
// tauri-boundary pass, and the em-dash pass.

const BRAND = "T" + "omat";

// Extensions oxlint already lints via the no-uppercase-tomat rule. Skipped here
// so a single occurrence is never reported twice; oxlint stays the authority
// for these, this pass owns everything else (including .svelte, see above).
const OXLINT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const ROOT = new URL("../../", import.meta.url).pathname;

interface Violation {
  file: string;
  line: number;
  column: number;
  text: string;
}

function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

async function trackedFiles(): Promise<string[]> {
  // `git ls-files` lists only tracked files, so node_modules, build artifacts,
  // and anything gitignored are excluded for free.
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    console.error("check-uppercase-tomat: `git ls-files` failed.");
    console.error(new TextDecoder().decode(out.stderr));
    Deno.exit(2);
  }
  return new TextDecoder()
    .decode(out.stdout)
    .split("\0")
    .filter((p) => p.length > 0);
}

async function scan(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const decoder = new TextDecoder();
  for (const file of await trackedFiles()) {
    if (OXLINT_EXTS.has(extOf(file))) continue;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(ROOT + file);
    } catch {
      continue; // unreadable (e.g. a broken symlink); nothing to scan
    }
    // Skip binaries the way `git grep -I` does: a NUL byte means not text.
    if (bytes.includes(0)) continue;
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i++) {
      let col = lines[i].indexOf(BRAND);
      while (col !== -1) {
        violations.push({ file, line: i + 1, column: col + 1, text: lines[i].trim() });
        col = lines[i].indexOf(BRAND, col + 1);
      }
    }
  }
  return violations;
}

const violations = await scan();
if (violations.length > 0) {
  console.error(
    `The brand must be lowercase (${violations.length} capital-initial occurrence(s) outside oxlint's reach):`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}  ${v.text}`);
  }
  console.error("\nLowercase it. The all-caps TOMAT_ env-var prefix is a separate token and fine.");
  Deno.exit(1);
}
