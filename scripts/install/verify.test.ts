// Fail-closed tests for the trust-critical verification path in the install
// scripts (scripts/install/{client,core}.sh). Both scripts embed the same
// Ed25519 verify crypto (ed25519_verify_file) and expose an offline TOMAT_SELFTEST
// mode that runs ONLY that verification against local fixtures - no network, no
// install, no UI. These tests drive that mode with an ephemeral keypair
// (TOMAT_SELFTEST_PUBKEY_B64 overrides the committed key) and assert:
//   - a valid signature verifies (exit 0),
//   - a tampered manifest is rejected (fail-closed, non-zero),
//   - a sha256 mismatch is rejected (fail-closed, non-zero).
// The two scripts verify DIFFERENT shapes: the client manifest carries a detached
// base64 signature over its raw bytes; the core manifest carries an EMBEDDED
// `signature` field over canonicalize(manifest minus .signature) (jq -Sjc), so
// each is exercised in its own shape.
//
// Requires OpenSSL 3.x (for `pkeyutl -rawin`), jq, and a sha256 tool. The scripts
// hard-require OpenSSL + a sha256 tool and auto-provision jq when it is missing;
// this test drives their canonical-JSON path directly, so jq must be present
// here. When OpenSSL 3.x is absent the suite is skipped (the scripts would refuse
// to run there anyway); CI runners have it.

import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import * as ed from "@noble/ed25519";

const CLIENT_SH = fromFileUrl(new URL("./client.sh", import.meta.url));
const CORE_SH = fromFileUrl(new URL("./core.sh", import.meta.url));
const enc = new TextEncoder();

/** Resolve an OpenSSL 3.x binary the way the install scripts do; null if none. */
async function openssl3(): Promise<string | null> {
  const cands = [
    "openssl",
    "/opt/homebrew/opt/openssl@3/bin/openssl",
    "/usr/local/opt/openssl@3/bin/openssl",
    "/opt/homebrew/bin/openssl",
    "/usr/local/bin/openssl",
  ];
  for (const c of cands) {
    try {
      const { success, stdout } = await new Deno.Command(c, {
        args: ["version"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (success && /^OpenSSL [3-9]/.test(new TextDecoder().decode(stdout))) return c;
    } catch {
      // not on PATH; try the next candidate
    }
  }
  return null;
}

const IGNORE = (await openssl3()) === null;

/** Run an install script in offline self-test mode and return its exit code. */
async function selftest(script: string, env: Record<string, string>): Promise<number> {
  const { code } = await new Deno.Command("bash", {
    args: [script],
    env: { ...Deno.env.toObject(), TOMAT_SELFTEST: "1", ...env },
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

async function sha256Hex(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** jq -Sjc 'del(.signature)' - the exact canonical form core.sh signs/verifies. */
async function canonicalizeCore(obj: unknown): Promise<Uint8Array> {
  const p = new Deno.Command("jq", {
    args: ["-Sjc", "del(.signature)"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(enc.encode(JSON.stringify(obj)));
  await w.close();
  const { stdout } = await p.output();
  return new Uint8Array(stdout);
}

Deno.test({
  name: "install script signature verification (fail-closed)",
  ignore: IGNORE,
  fn: async (t) => {
    // Ephemeral keypair; TOMAT_SELFTEST_PUBKEY_B64 makes the scripts trust it.
    const sk = ed.utils.randomSecretKey();
    const pubB64 = encodeBase64(await ed.getPublicKeyAsync(sk));
    const dir = await Deno.makeTempDir({ prefix: "tomat-verify-test-" });

    // --- client.sh: detached base64 signature over the raw manifest bytes ---
    const clientJson = JSON.stringify({
      version: "9.9.9",
      platforms: { "darwin-aarch64": { url: "https://x", sha256: "y" } },
    });
    const clientManifest = `${dir}/client.json`;
    const clientSigB64 = `${dir}/client.json.sig`;
    await Deno.writeTextFile(clientManifest, clientJson);
    await Deno.writeTextFile(
      clientSigB64,
      encodeBase64(await ed.signAsync(enc.encode(clientJson), sk)),
    );
    const clientEnv = {
      TOMAT_SELFTEST_PUBKEY_B64: pubB64,
      TOMAT_SELFTEST_MANIFEST: clientManifest,
      TOMAT_SELFTEST_SIG_B64: clientSigB64,
    };

    await t.step("client: valid detached signature is accepted", async () => {
      assertEquals(await selftest(CLIENT_SH, clientEnv), 0);
    });

    await t.step("client: tampered manifest is rejected", async () => {
      const tampered = `${dir}/client-tampered.json`;
      await Deno.writeTextFile(tampered, clientJson.replace("9.9.9", "6.6.6"));
      const code = await selftest(CLIENT_SH, { ...clientEnv, TOMAT_SELFTEST_MANIFEST: tampered });
      assert(code !== 0, "expected non-zero exit on a tampered manifest");
    });

    await t.step("client: sha256 mismatch is rejected", async () => {
      const artifact = `${dir}/artifact.bin`;
      await Deno.writeTextFile(artifact, "hello tomat");
      const good = await sha256Hex(artifact);
      // Correct hash still passes (signature + hash both valid).
      assertEquals(
        await selftest(CLIENT_SH, {
          ...clientEnv,
          TOMAT_SELFTEST_ARTIFACT: artifact,
          TOMAT_SELFTEST_SHA: good,
        }),
        0,
      );
      // Wrong hash fails closed even though the signature is valid.
      const code = await selftest(CLIENT_SH, {
        ...clientEnv,
        TOMAT_SELFTEST_ARTIFACT: artifact,
        TOMAT_SELFTEST_SHA: "deadbeef",
      });
      assert(code !== 0, "expected non-zero exit on a sha256 mismatch");
    });

    // --- core.sh: embedded signature over canonicalize(minus .signature) ---
    const coreObj = {
      version: "9.9.9",
      binaries: [{ triple: "aarch64-apple-darwin", url: "https://x", sha256: "y" }],
    };
    const coreSig = encodeBase64(await ed.signAsync(await canonicalizeCore(coreObj), sk));
    const coreManifest = `${dir}/core.json`;
    await Deno.writeTextFile(coreManifest, JSON.stringify({ ...coreObj, signature: coreSig }));
    const coreEnv = { TOMAT_SELFTEST_PUBKEY_B64: pubB64, TOMAT_SELFTEST_MANIFEST: coreManifest };

    await t.step("core: valid embedded signature is accepted", async () => {
      assertEquals(await selftest(CORE_SH, coreEnv), 0);
    });

    await t.step("core: tampered manifest is rejected", async () => {
      const tampered = `${dir}/core-tampered.json`;
      // Change a covered field but keep the old signature -> must fail closed.
      await Deno.writeTextFile(
        tampered,
        JSON.stringify({ ...coreObj, version: "6.6.6", signature: coreSig }),
      );
      const code = await selftest(CORE_SH, { ...coreEnv, TOMAT_SELFTEST_MANIFEST: tampered });
      assert(code !== 0, "expected non-zero exit on a tampered manifest");
    });

    await Deno.remove(dir, { recursive: true });
  },
});
