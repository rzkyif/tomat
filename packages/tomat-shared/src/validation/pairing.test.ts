// pairing-flow Zod schemas. These are the wire contract for the
// most-exposed surface (paired-client onboarding), so locking them down
// against contract drift is worth a few targeted assertions.

import { assertEquals } from "@std/assert";
import {
  pairingClaimRequestSchema,
  pairingCodeRequestSchema,
} from "./pairing.ts";

Deno.test("pairingCodeRequestSchema: accepts empty body (defaults)", () => {
  const parsed = pairingCodeRequestSchema.parse({});
  assertEquals(parsed, {});
});

Deno.test("pairingCodeRequestSchema: enforces ttlSec bounds (60 .. 3600)", () => {
  assertEquals(
    pairingCodeRequestSchema.safeParse({ ttlSec: 60 }).success,
    true,
  );
  assertEquals(
    pairingCodeRequestSchema.safeParse({ ttlSec: 3600 }).success,
    true,
  );
  assertEquals(
    pairingCodeRequestSchema.safeParse({ ttlSec: 59 }).success,
    false,
  );
  assertEquals(
    pairingCodeRequestSchema.safeParse({ ttlSec: 3601 }).success,
    false,
  );
  assertEquals(
    pairingCodeRequestSchema.safeParse({ ttlSec: 100.5 }).success,
    false,
  );
});

Deno.test("pairingCodeRequestSchema: rejects unknown fields (strict mode)", () => {
  const result = pairingCodeRequestSchema.safeParse({ ttlSec: 60, extra: 1 });
  assertEquals(result.success, false);
});

Deno.test("pairingClaimRequestSchema: accepts a 6-digit code + name", () => {
  const parsed = pairingClaimRequestSchema.parse({
    code: "123456",
    clientName: "my-laptop",
  });
  assertEquals(parsed.code, "123456");
  assertEquals(parsed.clientName, "my-laptop");
});

Deno.test("pairingClaimRequestSchema: rejects non-6-digit codes", () => {
  for (const code of ["12345", "1234567", "abcdef", "12 456"]) {
    assertEquals(
      pairingClaimRequestSchema.safeParse({ code, clientName: "x" }).success,
      false,
      `should reject code: ${code}`,
    );
  }
});

Deno.test("pairingClaimRequestSchema: rejects empty or >64-char clientName", () => {
  assertEquals(
    pairingClaimRequestSchema.safeParse({ code: "123456", clientName: "" })
      .success,
    false,
  );
  assertEquals(
    pairingClaimRequestSchema.safeParse({
      code: "123456",
      clientName: "x".repeat(65),
    }).success,
    false,
  );
});

Deno.test("pairingClaimRequestSchema: rejects unknown fields (strict mode)", () => {
  const result = pairingClaimRequestSchema.safeParse({
    code: "123456",
    clientName: "x",
    sneaky: true,
  });
  assertEquals(result.success, false);
});
