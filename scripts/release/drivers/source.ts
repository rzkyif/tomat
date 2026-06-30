// Packs the repo source into a tarball for build environments that can't
// bind-mount it (the Windows VM, reached over SSH). Excludes the heavy/build
// dirs the build doesn't need (node_modules, target, dist, tests, reference,
// generated client dirs); the guest fetches deno/cargo deps itself.

import { fail, REPO_ROOT } from "../lib.ts";

const EXCLUDES = [
  "*node_modules*",
  "*/.git",
  "*/.git/*",
  "./.git",
  "./.git/*",
  "*/target",
  "*/target/*",
  "./target",
  "./target/*",
  "./tests",
  "./tests/*",
  "./reference",
  "./reference/*",
  "*/dist",
  "*/dist/*",
  "./dist/*",
  "*/gen/*",
  "*/.svelte-kit/*",
  "*/.astro/*",
  "*/.wrangler/*",
  // macOS AppleDouble sidecars (xattr forks). BSD tar emits these `._*` entries
  // for files that carry extended attributes; extracted on the Windows guest they
  // become real files that Tauri then tries to parse (e.g. capabilities/._default
  // .json -> "stream did not contain valid UTF-8"). COPYFILE_DISABLE below stops
  // them being created; this excludes any that already exist on disk.
  "._*",
  "*/._*",
];

/** gzip-tar the repo (minus build/heavy dirs) into `destPath`. */
export async function packSourceTarball(destPath: string): Promise<void> {
  const args = [
    "czf",
    destPath,
    ...EXCLUDES.flatMap((e) => ["--exclude", e]),
    "-C",
    REPO_ROOT,
    ".",
  ];
  const { code } = await new Deno.Command("tar", {
    args,
    // COPYFILE_DISABLE=1 tells macOS BSD tar NOT to archive AppleDouble (`._*`)
    // entries for xattr'd files, so the guest never sees them.
    env: { ...Deno.env.toObject(), COPYFILE_DISABLE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) fail(`tar source pack exited ${code}`);
}
