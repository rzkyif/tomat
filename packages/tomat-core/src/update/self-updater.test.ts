// deterministic canonicalize() and base-64 decoder.
//
// `canonicalize` is the linchpin of manifest signing: the signer canonicalizes
// `{version, binaries}` to bytes, signs, and includes the signature; the
// verifier MUST produce the same bytes for verification to pass. Any
// divergence in key ordering, escaping, or array handling would
// undetectably brick the auto-update channel for every shipped core.

import { assertEquals } from "@std/assert";
import {
  __resetUpdateSubscribersForTesting,
  canonicalize,
  compareSemver,
  decodeBase64,
  emitUpdate,
  signedManifestPayload,
  subscribeUpdate,
  type UpdateEvent,
} from "./self-updater.ts";

Deno.test("canonicalize: object keys sorted lexicographically", () => {
  assertEquals(canonicalize({ b: 1, a: 2, c: 3 }), `{"a":2,"b":1,"c":3}`);
});

Deno.test("signedManifestPayload: covers workers + helpers, excludes signature, detects tampering", () => {
  const manifest = {
    schemaVersion: 1,
    version: "1.2.3",
    binaries: [
      {
        triple: "aarch64-apple-darwin",
        url: "https://x/c",
        sha256: "aa",
      },
    ],
    workers: [{ name: "tool-worker.ts", url: "https://x/w", sha256: "bb" }],
    helpers: [
      {
        name: "tomat-core-keychain",
        triple: "aarch64-apple-darwin",
        url: "https://x/k",
        sha256: "cc",
      },
    ],
    signature: "should-not-be-signed",
  };
  const payload = signedManifestPayload(manifest);
  // Every executed field is inside the signed bytes...
  assertEquals(payload.includes("tool-worker.ts"), true);
  assertEquals(payload.includes("tomat-core-keychain"), true);
  assertEquals(payload.includes("binaries"), true);
  // ...and the signature field itself is excluded.
  assertEquals(payload.includes("should-not-be-signed"), false);
  // Tampering a worker URL changes the signed bytes (so the signature fails).
  // This is the regression guard against narrowing coverage back to
  // {version, binaries}.
  const tamperedWorker = {
    ...manifest,
    workers: [{ name: "tool-worker.ts", url: "https://evil/w", sha256: "bb" }],
  };
  assertEquals(signedManifestPayload(manifest) === signedManifestPayload(tamperedWorker), false);
  // Tampering a helper hash likewise changes the signed bytes.
  const tamperedHelper = {
    ...manifest,
    helpers: [{ ...manifest.helpers[0], sha256: "ff" }],
  };
  assertEquals(signedManifestPayload(manifest) === signedManifestPayload(tamperedHelper), false);
});

Deno.test("canonicalize: nested objects recursively sorted", () => {
  assertEquals(
    canonicalize({ z: { b: 1, a: 2 }, a: { y: 1, x: 2 } }),
    `{"a":{"x":2,"y":1},"z":{"a":2,"b":1}}`,
  );
});

Deno.test("canonicalize: arrays preserve order (sorting would break signature)", () => {
  assertEquals(canonicalize([3, 1, 2]), `[3,1,2]`);
});

Deno.test("canonicalize: primitives match JSON.stringify", () => {
  assertEquals(canonicalize(42), "42");
  assertEquals(canonicalize("x"), `"x"`);
  assertEquals(canonicalize(null), "null");
  assertEquals(canonicalize(true), "true");
});

Deno.test("canonicalize: strings with quotes and backslashes are escaped per JSON", () => {
  assertEquals(canonicalize(`a"b\\c`), `"a\\"b\\\\c"`);
});

Deno.test("canonicalize: realistic manifest body round-trips deterministically", () => {
  const body = {
    version: "0.2.0",
    binaries: [
      { triple: "aarch64-apple-darwin", url: "https://x/a", sha256: "00" },
      { triple: "x86_64-pc-windows-msvc", url: "https://x/w", sha256: "00" },
    ],
  };
  // Two independent invocations produce the same bytes (signing+verifying
  // both call this, so bit-for-bit equality is the contract).
  assertEquals(canonicalize(body), canonicalize(body));
  // Reordering input keys produces the same output.
  const reorder = { binaries: body.binaries, version: body.version };
  assertEquals(canonicalize(reorder), canonicalize(body));
});

Deno.test("decodeBase64: round-trips known fixture (ed25519 public key length is 32)", () => {
  // `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` -> 32 zero bytes.
  const out = decodeBase64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  assertEquals(out.length, 32);
  for (const b of out) assertEquals(b, 0);
});

Deno.test("decodeBase64: ASCII round-trip via btoa matches Web standard", () => {
  const s = "hello";
  const b64 = btoa(s);
  const out = decodeBase64(b64);
  assertEquals(new TextDecoder().decode(out), s);
});

// --- subscribe/emit ---------------------------------------------------------

Deno.test("subscribeUpdate: subscriber receives emitted staged event", () => {
  __resetUpdateSubscribersForTesting();
  const received: UpdateEvent[] = [];
  const unsubscribe = subscribeUpdate((e) => received.push(e));
  try {
    emitUpdate({ kind: "staged", version: "1.2.3" });
    assertEquals(received, [{ kind: "staged", version: "1.2.3" }]);
  } finally {
    unsubscribe();
  }
});

Deno.test("subscribeUpdate: multiple subscribers each receive", () => {
  __resetUpdateSubscribersForTesting();
  const a: UpdateEvent[] = [];
  const b: UpdateEvent[] = [];
  const unsubA = subscribeUpdate((e) => a.push(e));
  const unsubB = subscribeUpdate((e) => b.push(e));
  try {
    emitUpdate({
      kind: "error",
      code: "update_failed",
      message: "boom",
    });
    assertEquals(a.length, 1);
    assertEquals(b.length, 1);
    assertEquals(a[0], b[0]);
  } finally {
    unsubA();
    unsubB();
  }
});

Deno.test("subscribeUpdate: unsubscribe stops delivery", () => {
  __resetUpdateSubscribersForTesting();
  const received: UpdateEvent[] = [];
  const unsubscribe = subscribeUpdate((e) => received.push(e));
  emitUpdate({ kind: "staged", version: "1" });
  unsubscribe();
  emitUpdate({ kind: "staged", version: "2" });
  assertEquals(received, [{ kind: "staged", version: "1" }]);
});

Deno.test("subscribeUpdate: a throwing subscriber does not block others", () => {
  __resetUpdateSubscribersForTesting();
  const received: UpdateEvent[] = [];
  const unsubA = subscribeUpdate(() => {
    throw new Error("subscriber threw");
  });
  const unsubB = subscribeUpdate((e) => received.push(e));
  try {
    emitUpdate({ kind: "staged", version: "ok" });
    assertEquals(received, [{ kind: "staged", version: "ok" }]);
  } finally {
    unsubA();
    unsubB();
  }
});

Deno.test("__resetUpdateSubscribersForTesting: clears the subscriber set", () => {
  __resetUpdateSubscribersForTesting();
  const received: UpdateEvent[] = [];
  subscribeUpdate((e) => received.push(e));
  __resetUpdateSubscribersForTesting();
  emitUpdate({ kind: "staged", version: "1" });
  assertEquals(received, []);
});

// --- compareSemver --------------------------------------------------------

Deno.test("compareSemver: equal versions return 0", () => {
  assertEquals(compareSemver("1.2.3", "1.2.3"), 0);
});

Deno.test("compareSemver: orders by major, then minor, then patch", () => {
  assertEquals(compareSemver("1.0.0", "2.0.0"), -1);
  assertEquals(compareSemver("2.0.0", "1.0.0"), 1);
  assertEquals(compareSemver("1.2.0", "1.10.0"), -1);
  assertEquals(compareSemver("1.10.0", "1.2.0"), 1);
  assertEquals(compareSemver("1.2.3", "1.2.10"), -1);
});

Deno.test("compareSemver: ignores prerelease + build metadata", () => {
  assertEquals(compareSemver("1.2.3-alpha", "1.2.3"), 0);
  assertEquals(compareSemver("1.2.3+build.99", "1.2.3"), 0);
});

Deno.test("compareSemver: missing minor/patch defaults to 0", () => {
  assertEquals(compareSemver("1", "1.0.0"), 0);
  assertEquals(compareSemver("1.5", "1.5.0"), 0);
});
