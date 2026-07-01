// Guards that the Apple Developer ID signing plumbing stays INERT by default:
// with no APPLE_* set (the shipped state), appleSigningEnv injects nothing, so
// the macOS build keeps ad-hoc signing and every other platform is untouched.
// Also confirms the fields ARE injected once set (so a future edit can't quietly
// break the wiring) and that non-macOS targets never receive them.

import { assertEquals } from "@std/assert";

import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import { appleSigningEnv } from "./client.ts";
import type { DeployEnv } from "./lib.ts";

const DARWIN: Triple = "aarch64-apple-darwin";
const WINDOWS: Triple = "x86_64-pc-windows-msvc";

/** A fully-empty DeployEnv: mirrors a .env with no signing secrets filled in. */
function blankEnv(overrides: Partial<DeployEnv> = {}): DeployEnv {
  return {
    signingPrivateKey: new Uint8Array(),
    signingPublicKey: new Uint8Array(),
    cloudflareApiToken: "",
    cloudflareAccountId: "",
    websiteDomain: "",
    storageDomain: "",
    r2Bucket: "",
    tauriUpdaterPublicKey: "",
    tauriUpdaterPrivateKey: "",
    tauriUpdaterPassword: "",
    androidKeystoreB64: "",
    androidKeystorePassword: "",
    androidKeyAlias: "",
    androidKeyPassword: "",
    appleSigningIdentity: "",
    appleCertificateB64: "",
    appleCertificatePassword: "",
    appleId: "",
    applePassword: "",
    appleTeamId: "",
    appleApiKey: "",
    appleApiIssuer: "",
    appleApiKeyPath: "",
    ...overrides,
  };
}

Deno.test("appleSigningEnv: blank env injects nothing (inert by default)", () => {
  assertEquals(appleSigningEnv(blankEnv(), DARWIN), {});
});

Deno.test("appleSigningEnv: only non-empty fields are injected, no blanks", () => {
  const env = blankEnv({
    appleSigningIdentity: "Developer ID Application: Someone (TEAMID1234)",
    appleId: "dev@example.com",
    applePassword: "app-specific-pw",
    appleTeamId: "TEAMID1234",
  });
  assertEquals(appleSigningEnv(env, DARWIN), {
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (TEAMID1234)",
    APPLE_ID: "dev@example.com",
    APPLE_PASSWORD: "app-specific-pw",
    APPLE_TEAM_ID: "TEAMID1234",
  });
});

Deno.test("appleSigningEnv: never injected on a non-macOS target", () => {
  const env = blankEnv({ appleSigningIdentity: "Developer ID Application: Someone (TEAMID1234)" });
  assertEquals(appleSigningEnv(env, WINDOWS), {});
});
