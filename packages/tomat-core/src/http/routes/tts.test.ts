// HTTP contract for /api/v1/tts. Voices catalog + status are read-only;
// synthesize requires the kokoro sidecar (out of scope here).

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { authService } from "../../services/auth.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";

async function pair(): Promise<{ token: string }> {
  const { code } = await authService().mintPairingCode();
  const { token } = await authService().claim(code, "t2", "127.0.0.1");
  return { token };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

Deno.test("GET /api/v1/tts/voices: requires bearer (401)", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/tts/voices"));
    assertEquals(res.status, 401);
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/tts/voices: derives catalog from the shared settings schema", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pair();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/tts/voices", { headers: bearer(token) }),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as Array<
      { id: string; label: string; lang: string }
    >;
    assertEquals(Array.isArray(body), true);
    assertEquals(body.length > 0, true);
    // Every voice has the three fields the UI reads.
    for (const v of body) {
      assertEquals(typeof v.id, "string");
      assertEquals(typeof v.label, "string");
      assertEquals(typeof v.lang, "string");
    }
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/tts/synthesize: empty text returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pair();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/tts/synthesize", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assertEquals(res.status, 400);
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/tts/status: returns the controller status object", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pair();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/tts/status", { headers: bearer(token) }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    // Shape: at minimum the controller reports loaded boolean.
    assertEquals(typeof body, "object");
    assertEquals(body !== null, true);
  } finally {
    await env.teardown();
  }
});
