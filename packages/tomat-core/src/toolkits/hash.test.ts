// toolkit content-hash determinism + .gitignore semantics. Uses real
// tempdir filesystem because the function walks Deno.readDir; not feasible
// to mock without a lot of indirection. Tempdir-only, no global state.

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { hashToolkit } from "./hash.ts";

async function makeToolkit(layout: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-hash-t0-" });
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(dir, rel);
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    if (parent && parent !== dir) {
      await Deno.mkdir(parent, { recursive: true });
    }
    await Deno.writeTextFile(abs, content);
  }
  return dir;
}

Deno.test("hashToolkit: identical layouts produce identical hashes (determinism)", async () => {
  const a = await makeToolkit({
    "tools.json": `{ "name": "x" }`,
    "src/index.ts": `export const x = 1;`,
  });
  const b = await makeToolkit({
    "tools.json": `{ "name": "x" }`,
    "src/index.ts": `export const x = 1;`,
  });
  try {
    assertEquals(await hashToolkit(a), await hashToolkit(b));
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("hashToolkit: changing file content changes the hash", async () => {
  const dir = await makeToolkit({
    "tools.json": `{ "name": "x" }`,
    "src/index.ts": `export const x = 1;`,
  });
  try {
    const before = await hashToolkit(dir);
    await Deno.writeTextFile(join(dir, "src/index.ts"), "export const x = 2;");
    const after = await hashToolkit(dir);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hashToolkit: node_modules is always excluded (no hash drift from npm install)", async () => {
  const a = await makeToolkit({
    "tools.json": `{}`,
    "node_modules/.package-lock.json": `lockfile`,
    "node_modules/foo/index.js": `module.exports = 1`,
  });
  const b = await makeToolkit({ "tools.json": `{}` });
  try {
    assertEquals(await hashToolkit(a), await hashToolkit(b));
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("hashToolkit: .gitignore'd files are excluded but the .gitignore itself is hashed", async () => {
  const a = await makeToolkit({
    "tools.json": `{}`,
    ".gitignore": "secrets/\n",
    "secrets/key": `s3cret`,
  });
  // Same layout, but secrets/ contents differ. They must hash the same
  // since they're excluded.
  const b = await makeToolkit({
    "tools.json": `{}`,
    ".gitignore": "secrets/\n",
    "secrets/key": `different-but-ignored`,
  });
  try {
    assertEquals(await hashToolkit(a), await hashToolkit(b));
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("hashToolkit: changing .gitignore drifts the hash (rules are content)", async () => {
  const a = await makeToolkit({
    "tools.json": `{}`,
    ".gitignore": "secrets/\n",
  });
  const b = await makeToolkit({
    "tools.json": `{}`,
    ".gitignore": "other/\n",
  });
  try {
    assertNotEquals(await hashToolkit(a), await hashToolkit(b));
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("hashToolkit: hash is a 64-char lowercase hex string (SHA-256)", async () => {
  const dir = await makeToolkit({ "tools.json": `{}` });
  try {
    const h = await hashToolkit(dir);
    assertEquals(/^[0-9a-f]{64}$/.test(h), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
