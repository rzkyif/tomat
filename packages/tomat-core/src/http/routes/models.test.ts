// HTTP contract for /api/v1/models. Network-heavy actions
// (download, probe of remote sources) are exercised indirectly via the
// fast paths (alreadyHave / validation rejections); the network surface
// is covered separately by manager + sources tests.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { pairClient } from "../../../tests/helpers/pairing.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";

async function pairOne(): Promise<{ token: string }> {
  const { token } = await pairClient("t2", "127.0.0.1");
  return { token };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

Deno.test("GET /api/v1/models: requires bearer (401)", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/models"));
    assertEquals(res.status, 401);
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/models: returns empty array on a fresh tempdir", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/models", { headers: bearer(token) }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), []);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/models/ensure: bad kind returns 400 with validation_error", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/models/ensure", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ kind: "lol" }),
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/models/probe: malformed sources array returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/models/probe", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ sources: "not-an-array" }),
      }),
    );
    assertEquals(res.status, 400);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/models/download: missing items array returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/models/download", {
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

Deno.test("GET /api/v1/models/downloads: empty list before any enqueue", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/models/downloads", {
        headers: bearer(token),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), []);
  } finally {
    await env.teardown();
  }
});
