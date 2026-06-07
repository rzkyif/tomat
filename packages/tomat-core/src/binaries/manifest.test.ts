// Binary-manifest signature + shape verification. These are the controls that
// keep a tampered/MITM'd binaries manifest from installing attacker-chosen
// binaries, yet had zero coverage. The signature check is exercised with a
// throwaway keypair via the key-injectable `verifyBinariesSignature`; the
// production path passes the embedded signing key.

import { assertEquals, assertThrows } from "@std/assert";
import * as ed from "@noble/ed25519";
import { encodeBase64 } from "@std/encoding/base64";
import { canonicalize } from "@tomat/shared";
import { assertManifestShape, verifyBinariesSignature } from "./manifest.ts";
import { AppError } from "../shared/errors.ts";

const SAMPLE_BINARIES = {
  "llama-server": {
    version: "1.2.3",
    platforms: { "aarch64-apple-darwin": { url: "https://r2/x", sha256: "abc" } },
  },
};

async function signBinaries(binaries: unknown, priv: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalize(binaries)), priv);
  return encodeBase64(sig);
}

Deno.test("verifyBinariesSignature: accepts a correctly signed binaries body", async () => {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const sig = await signBinaries(SAMPLE_BINARIES, priv);
  assertEquals(await verifyBinariesSignature(SAMPLE_BINARIES, sig, pub), true);
});

Deno.test("verifyBinariesSignature: rejects a tampered binaries body", async () => {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const sig = await signBinaries(SAMPLE_BINARIES, priv);
  // Attacker swaps the download URL/sha after signing.
  const tampered = {
    "llama-server": {
      version: "1.2.3",
      platforms: { "aarch64-apple-darwin": { url: "https://evil/x", sha256: "abc" } },
    },
  };
  assertEquals(await verifyBinariesSignature(tampered, sig, pub), false);
});

Deno.test("verifyBinariesSignature: rejects a signature made with a different key", async () => {
  const priv = ed.utils.randomPrivateKey();
  const otherPub = await ed.getPublicKeyAsync(ed.utils.randomPrivateKey());
  const sig = await signBinaries(SAMPLE_BINARIES, priv);
  assertEquals(await verifyBinariesSignature(SAMPLE_BINARIES, sig, otherPub), false);
});

Deno.test("assertManifestShape: accepts a valid manifest", () => {
  assertManifestShape({ schemaVersion: 1, binaries: {}, signature: "abc" });
});

Deno.test("assertManifestShape: rejects a missing/empty signature", () => {
  assertThrows(
    () => assertManifestShape({ schemaVersion: 1, binaries: {} }),
    AppError,
    "missing signature",
  );
  assertThrows(
    () => assertManifestShape({ schemaVersion: 1, binaries: {}, signature: "" }),
    AppError,
    "missing signature",
  );
});

Deno.test("assertManifestShape: rejects a wrong schemaVersion / missing binaries / non-object", () => {
  assertThrows(
    () => assertManifestShape({ schemaVersion: 2, binaries: {}, signature: "x" }),
    AppError,
    "schemaVersion",
  );
  assertThrows(
    () => assertManifestShape({ schemaVersion: 1, signature: "x" }),
    AppError,
    "missing binaries",
  );
  assertThrows(() => assertManifestShape(null), AppError, "not an object");
});
