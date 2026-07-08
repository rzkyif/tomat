// Fail-closed tests for the trust-critical verification path in the install
// scripts (scripts/install/{client,core}.{sh,ps1}). Every script embeds the same
// Ed25519 verify crypto and exposes an offline TOMAT_SELFTEST mode that runs ONLY
// that verification against local fixtures - no network, no install, no UI. These
// tests drive that mode with an ephemeral keypair (TOMAT_SELFTEST_PUBKEY_B64
// overrides the committed key) and assert:
//   - a valid signature verifies (exit 0),
//   - a tampered manifest is rejected (fail-closed, non-zero),
//   - a sha256 mismatch is rejected (fail-closed, non-zero).
// The two scripts verify DIFFERENT shapes: the client manifest carries a detached
// base64 signature over its raw bytes; the core manifest carries an EMBEDDED
// `signature` field over canonicalize(manifest minus .signature), so each is
// exercised in its own shape. The fixture is signed with the PRODUCTION
// canonicalize() (see canonicalizeCore), so a passing run proves each runner
// reproduces the real signer's bytes.
//
// Two runners: the POSIX shell scripts (bash + OpenSSL 3.x + jq) and the Windows
// PowerShell scripts (pwsh/powershell, whose verifier is a self-contained
// pure-PowerShell Ed25519 + canonical-JSON implementation). Each runner is
// skipped when its interpreter/crypto tool is absent (the scripts refuse to run
// there anyway); CI runners have bash+OpenSSL, and the PowerShell lane runs
// wherever pwsh is installed. The POSIX core cases still need jq present, since
// core.sh canonicalizes at runtime with `jq -Sjc del(.signature)`.

import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import * as ed from "@noble/ed25519";
// The production canonicalizer the release signer uses, so the fixture is signed
// over the exact bytes core.{sh,ps1} must reproduce (not jq's approximation).
import { canonicalize } from "../../packages/tomat-shared/src/crypto/canonical.ts";

const CLIENT_SH = fromFileUrl(new URL("./client.sh", import.meta.url));
const CORE_SH = fromFileUrl(new URL("./core.sh", import.meta.url));
const CLIENT_PS1 = fromFileUrl(new URL("./client.ps1", import.meta.url));
const CORE_PS1 = fromFileUrl(new URL("./core.ps1", import.meta.url));
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

/** Resolve a PowerShell interpreter (pwsh preferred, then Windows powershell). */
async function pwsh(): Promise<string | null> {
  for (const c of ["pwsh", "powershell"]) {
    try {
      const { success } = await new Deno.Command(c, {
        args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (success) return c;
    } catch {
      // not on PATH; try the next candidate
    }
  }
  return null;
}

const IGNORE_SH = (await openssl3()) === null;
const PWSH = await pwsh();
const IGNORE_PS = PWSH === null;

/** How to run each installer variant's offline self-test and return its exit code. */
interface Runner {
  name: string;
  client: string;
  core: string;
  ignore: boolean;
  run: (script: string, env: Record<string, string>) => Promise<number>;
}

const RUNNERS: Runner[] = [
  {
    name: "sh",
    client: CLIENT_SH,
    core: CORE_SH,
    ignore: IGNORE_SH,
    run: async (script, env) => {
      const { code } = await new Deno.Command("bash", {
        args: [script],
        env: { ...Deno.env.toObject(), TOMAT_SELFTEST: "1", ...env },
        stdout: "null",
        stderr: "null",
      }).output();
      return code;
    },
  },
  {
    name: "ps1",
    client: CLIENT_PS1,
    core: CORE_PS1,
    ignore: IGNORE_PS,
    run: async (script, env) => {
      const { code } = await new Deno.Command(PWSH ?? "pwsh", {
        args: ["-NoProfile", "-NonInteractive", "-File", script],
        env: { ...Deno.env.toObject(), TOMAT_SELFTEST: "1", ...env },
        stdout: "null",
        stderr: "null",
      }).output();
      return code;
    },
  },
];

async function sha256Hex(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact canonical bytes the release signer produces for a core manifest:
 *  the PRODUCTION canonicalize() over the manifest minus its `signature` field.
 *  Signing the fixture with this (rather than jq) makes the suite prove that
 *  BOTH runners - core.ps1's ConvertTo-CanonicalJson and core.sh's runtime
 *  `jq -Sjc del(.signature)` - reproduce the real signer's bytes, not merely
 *  that they agree with jq. For an ASCII manifest the three coincide; a future
 *  divergence (a non-ASCII value jq and canonicalize serialize differently)
 *  would now surface as a failing runner instead of a silently-broken install. */
function canonicalizeCore(obj: Record<string, unknown>): Uint8Array {
  const { signature: _omitSignature, ...body } = obj;
  return enc.encode(canonicalize(body));
}

for (const runner of RUNNERS) {
  Deno.test({
    name: `install script signature verification (fail-closed) [${runner.name}]`,
    ignore: runner.ignore,
    fn: async (t) => {
      // Ephemeral keypair; TOMAT_SELFTEST_PUBKEY_B64 makes the scripts trust it.
      const sk = ed.utils.randomSecretKey();
      const pubB64 = encodeBase64(await ed.getPublicKeyAsync(sk));
      const dir = await Deno.makeTempDir({ prefix: `tomat-verify-test-${runner.name}-` });

      // --- client: detached base64 signature over the raw manifest bytes ---
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
        assertEquals(await runner.run(runner.client, clientEnv), 0);
      });

      await t.step("client: tampered manifest is rejected", async () => {
        const tampered = `${dir}/client-tampered.json`;
        await Deno.writeTextFile(tampered, clientJson.replace("9.9.9", "6.6.6"));
        const code = await runner.run(runner.client, {
          ...clientEnv,
          TOMAT_SELFTEST_MANIFEST: tampered,
        });
        assert(code !== 0, "expected non-zero exit on a tampered manifest");
      });

      await t.step("client: sha256 mismatch is rejected", async () => {
        const artifact = `${dir}/artifact.bin`;
        await Deno.writeTextFile(artifact, "hello tomat");
        const good = await sha256Hex(artifact);
        // Correct hash still passes (signature + hash both valid).
        assertEquals(
          await runner.run(runner.client, {
            ...clientEnv,
            TOMAT_SELFTEST_ARTIFACT: artifact,
            TOMAT_SELFTEST_SHA: good,
          }),
          0,
        );
        // Wrong hash fails closed even though the signature is valid.
        const code = await runner.run(runner.client, {
          ...clientEnv,
          TOMAT_SELFTEST_ARTIFACT: artifact,
          TOMAT_SELFTEST_SHA: "deadbeef",
        });
        assert(code !== 0, "expected non-zero exit on a sha256 mismatch");
      });

      // --- core: embedded signature over canonicalize(minus .signature) ---
      const coreObj = {
        version: "9.9.9",
        binaries: [{ triple: "aarch64-apple-darwin", url: "https://x", sha256: "y" }],
      };
      const coreSig = encodeBase64(await ed.signAsync(canonicalizeCore(coreObj), sk));
      const coreManifest = `${dir}/core.json`;
      await Deno.writeTextFile(coreManifest, JSON.stringify({ ...coreObj, signature: coreSig }));
      const coreEnv = { TOMAT_SELFTEST_PUBKEY_B64: pubB64, TOMAT_SELFTEST_MANIFEST: coreManifest };

      await t.step("core: valid embedded signature is accepted", async () => {
        assertEquals(await runner.run(runner.core, coreEnv), 0);
      });

      await t.step("core: tampered manifest is rejected", async () => {
        const tampered = `${dir}/core-tampered.json`;
        // Change a covered field but keep the old signature -> must fail closed.
        await Deno.writeTextFile(
          tampered,
          JSON.stringify({ ...coreObj, version: "6.6.6", signature: coreSig }),
        );
        const code = await runner.run(runner.core, {
          ...coreEnv,
          TOMAT_SELFTEST_MANIFEST: tampered,
        });
        assert(code !== 0, "expected non-zero exit on a tampered manifest");
      });

      await Deno.remove(dir, { recursive: true });
    },
  });
}

// CI tripwire: each lane skips when its interpreter/crypto tool is absent, which
// is correct locally but would silently drop this security-critical coverage if a
// CI runner image ever stopped shipping OpenSSL 3.x or pwsh. When
// TOMAT_REQUIRE_INSTALL_VERIFY is set (the CI step sets it on ubuntu-latest, which
// has both), a missing interpreter FAILS the suite instead of skipping it.
Deno.test({
  name: "install-verify: both lanes actually ran (CI tripwire)",
  ignore: !Deno.env.get("TOMAT_REQUIRE_INSTALL_VERIFY"),
  fn: () => {
    assert(!IGNORE_SH, "sh lane skipped: no OpenSSL 3.x found (required in CI)");
    assert(!IGNORE_PS, "ps1 lane skipped: no pwsh/powershell found (required in CI)");
  },
});
