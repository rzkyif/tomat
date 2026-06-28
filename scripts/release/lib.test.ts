// Tests for mergeVersionHistory, the pure retention logic that decides which
// versioned R2 artifacts to keep and which to evict on each release.

import { assertEquals } from "@std/assert";

import { mergeVersionHistory } from "./lib.ts";

Deno.test("first release: one entry, nothing evicted", () => {
  const r = mergeVersionHistory(undefined, "1.0.0", ["1.0.0/a", "1.0.0/b"], 2);
  assertEquals(r.history, [{ version: "1.0.0", keys: ["1.0.0/a", "1.0.0/b"] }]);
  assertEquals(r.evictedKeys, []);
});

Deno.test("new version goes to the front; within cap nothing evicts", () => {
  const prior = [{ version: "1.0.0", keys: ["1.0.0/a"] }];
  const r = mergeVersionHistory(prior, "1.0.1", ["1.0.1/a"], 2);
  assertEquals(r.history, [
    { version: "1.0.1", keys: ["1.0.1/a"] },
    { version: "1.0.0", keys: ["1.0.0/a"] },
  ]);
  assertEquals(r.evictedKeys, []);
});

Deno.test("exceeding cap evicts the oldest version's keys", () => {
  const prior = [
    { version: "1.0.1", keys: ["1.0.1/a"] },
    { version: "1.0.0", keys: ["1.0.0/a", "1.0.0/b"] },
  ];
  const r = mergeVersionHistory(prior, "1.0.2", ["1.0.2/a"], 2);
  assertEquals(r.history, [
    { version: "1.0.2", keys: ["1.0.2/a"] },
    { version: "1.0.1", keys: ["1.0.1/a"] },
  ]);
  assertEquals(r.evictedKeys, ["1.0.0/a", "1.0.0/b"]);
});

Deno.test("same version republished: keys union in place, no eviction", () => {
  const prior = [
    { version: "1.0.1", keys: ["1.0.1/mac"] },
    { version: "1.0.0", keys: ["1.0.0/a"] },
  ];
  // Platform-fill: a new windows bundle plus a re-uploaded mac bundle.
  const r = mergeVersionHistory(prior, "1.0.1", ["1.0.1/mac", "1.0.1/win"], 2);
  assertEquals(r.history, [
    { version: "1.0.1", keys: ["1.0.1/mac", "1.0.1/win"] },
    { version: "1.0.0", keys: ["1.0.0/a"] },
  ]);
  assertEquals(r.evictedKeys, []);
});

Deno.test("duplicate keys within a single record are deduped", () => {
  const r = mergeVersionHistory(undefined, "1.0.0", ["1.0.0/a", "1.0.0/a"], 2);
  assertEquals(r.history, [{ version: "1.0.0", keys: ["1.0.0/a"] }]);
  assertEquals(r.evictedKeys, []);
});
