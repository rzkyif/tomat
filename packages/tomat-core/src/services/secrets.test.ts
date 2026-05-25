// secrets vault round-trips encrypted bag through AES-GCM, persists
// across opens, validates name/value, deletes idempotently, and protects
// against tampered ciphertext.
//
// The OS-keychain helper binary is absent in tests (no build artifacts
// under bin/), so keychainGet/Set silently return null/false and the
// vault falls back to a chmod-600 .master-key file under
// TOMAT_CORE_HOME. That's the exact fallback the production code already
// supports; it just means tests exercise the file-backed branch.

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import {
  deleteSecret,
  getSecret,
  listSecretNames,
  setSecret,
} from "./secrets.ts";
import { AppError } from "../shared/errors.ts";

Deno.test("setSecret + getSecret: round-trips a value", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("openai-api-key", "sk-test-1234");
    assertEquals(await getSecret("openai-api-key"), "sk-test-1234");
  } finally {
    await env.teardown();
  }
});

Deno.test("getSecret: returns undefined for a name that was never set", async () => {
  const env = await setupTestEnv();
  try {
    assertEquals(await getSecret("absent"), undefined);
  } finally {
    await env.teardown();
  }
});

Deno.test("setSecret + setSecret(same name): overwrites and re-encrypts", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("k", "v1");
    await setSecret("k", "v2");
    assertEquals(await getSecret("k"), "v2");
  } finally {
    await env.teardown();
  }
});

Deno.test("listSecretNames: returns keys sorted alphabetically", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("z-secret", "1");
    await setSecret("a-secret", "2");
    await setSecret("m-secret", "3");
    assertEquals(await listSecretNames(), ["a-secret", "m-secret", "z-secret"]);
  } finally {
    await env.teardown();
  }
});

Deno.test("deleteSecret: returns true on first call, false on subsequent", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("doomed", "v");
    assertEquals(await deleteSecret("doomed"), true);
    assertEquals(await deleteSecret("doomed"), false);
    assertEquals(await getSecret("doomed"), undefined);
  } finally {
    await env.teardown();
  }
});

Deno.test("setSecret: rejects empty / non-string name and non-string value", async () => {
  const env = await setupTestEnv();
  try {
    await assertRejects(
      () => setSecret("", "v"),
      AppError,
      "non-empty string",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => setSecret("k", 42 as any),
      AppError,
      "must be a string",
    );
  } finally {
    await env.teardown();
  }
});

Deno.test("secrets.enc: tampered ciphertext is rejected as decryption failure", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("k", "v");
    const blob = await Deno.readFile(paths().secretsEncFile);
    // Flip the last byte of the ciphertext (auth tag is at the end on
    // AES-GCM, so any change there must trip GCM authentication).
    blob[blob.length - 1] ^= 0xff;
    await Deno.writeFile(paths().secretsEncFile, blob);
    await assertRejects(
      () => getSecret("k"),
      AppError,
      "decryption failed",
    );
  } finally {
    await env.teardown();
  }
});

Deno.test("secrets.enc: nonce changes between writes (non-deterministic encryption)", async () => {
  const env = await setupTestEnv();
  try {
    await setSecret("k", "same-value");
    const a = await Deno.readFile(paths().secretsEncFile);
    await setSecret("k", "same-value");
    const b = await Deno.readFile(paths().secretsEncFile);
    // First 12 bytes are the nonce. Across two writes of the same plaintext
    // they MUST differ — otherwise we'd have catastrophic GCM nonce reuse.
    assertNotEquals(
      Array.from(a.subarray(0, 12)).join(","),
      Array.from(b.subarray(0, 12)).join(","),
    );
  } finally {
    await env.teardown();
  }
});
