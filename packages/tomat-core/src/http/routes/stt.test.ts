// HTTP contract for /api/v1/stt. Provider switching is settings-driven
// and external mode needs network — we only assert auth + validation.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { pairClient } from "../../../tests/helpers/pairing.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";

async function pair(): Promise<{ token: string }> {
  const { token } = await pairClient("t2", "127.0.0.1");
  return { token };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

Deno.test("POST /api/v1/stt/transcribe: requires bearer (401)", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/stt/transcribe", { method: "POST" }),
    );
    assertEquals(res.status, 401);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/stt/transcribe: missing audio file returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pair();
    const app = buildApp();
    const form = new FormData();
    // Intentionally no audio entry.
    form.set("language", "en");
    const res = await app.fetch(
      new Request("http://x/api/v1/stt/transcribe", {
        method: "POST",
        headers: bearer(token),
        body: form,
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
  } finally {
    await env.teardown();
  }
});
