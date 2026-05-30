// HTTP contract for /api/v1/toolkits. Avoids exercising npm install
// (network); the local-install path is verified by installer.t1. Here we
// only assert routing, auth, validation, and the read-only views over a
// tempdir registry.

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

Deno.test("GET /api/v1/toolkits: requires bearer (401)", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/toolkits"));
    assertEquals(res.status, 401);
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/toolkits: empty list before any install", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits", { headers: bearer(token) }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), []);
  } finally {
    await env.teardown();
  }
});

Deno.test("DELETE /api/v1/toolkits/:id: 404 with toolkit_not_found when id is unknown", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/no-such-id", {
        method: "DELETE",
        headers: bearer(token),
      }),
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "toolkit_not_found");
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/toolkits/install: unknown source kind returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/install", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ source: "ftp", name: "x" }),
      }),
    );
    assertEquals(res.status, 400);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/toolkits/install: local source requires slug (400)", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/install", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ source: "local", path: "/tmp/x" }),
      }),
    );
    assertEquals(res.status, 400);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/toolkits/filter: vector array required (400 when missing)", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/filter", {
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

Deno.test("POST /api/v1/toolkits/embed: texts array required (400 when missing)", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/embed", {
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
