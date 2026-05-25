// HTTP contract for /api/v1/settings and the secrets sub-resource.
// Asserts the "names only, never values" rule that the secrets endpoint
// promises.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { authService } from "../../services/auth.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";

async function pairOne(): Promise<string> {
  const { code } = await authService().mintPairingCode();
  const { token } = await authService().claim(code, "settings-t", "127.0.0.1");
  return token;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

Deno.test("GET /api/v1/settings: returns {} for a fresh core", async () => {
  const env = await setupTestEnv();
  try {
    const token = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/settings", { headers: bearer(token) }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {});
  } finally {
    await env.teardown();
  }
});

Deno.test("PATCH /api/v1/settings: persists keys and returns the merged object", async () => {
  const env = await setupTestEnv();
  try {
    const token = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/settings", {
        method: "PATCH",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ "ui.theme": "dark" }),
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body["ui.theme"], "dark");
  } finally {
    await env.teardown();
  }
});

Deno.test("PATCH /api/v1/settings: rejects non-object body with 400", async () => {
  const env = await setupTestEnv();
  try {
    const token = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/settings", {
        method: "PATCH",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
  } finally {
    await env.teardown();
  }
});

Deno.test("PUT /api/v1/settings/secrets/:name: stores secret then GET returns name only (never value)", async () => {
  const env = await setupTestEnv();
  try {
    const token = await pairOne();
    const app = buildApp();
    const put = await app.fetch(
      new Request("http://x/api/v1/settings/secrets/openai-api-key", {
        method: "PUT",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ value: "sk-secret-do-not-leak" }),
      }),
    );
    assertEquals(put.status, 204);

    const list = await app.fetch(
      new Request("http://x/api/v1/settings/secrets", {
        headers: bearer(token),
      }),
    );
    const body = await list.json();
    assertEquals(body, { names: ["openai-api-key"] });
    // No value field anywhere in the response.
    assertEquals(JSON.stringify(body).includes("sk-secret"), false);
  } finally {
    await env.teardown();
  }
});

Deno.test("DELETE /api/v1/settings/secrets/:name: 404 when the name was never set", async () => {
  const env = await setupTestEnv();
  try {
    const token = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/settings/secrets/absent", {
        method: "DELETE",
        headers: bearer(token),
      }),
    );
    assertEquals(res.status, 404);
  } finally {
    await env.teardown();
  }
});
