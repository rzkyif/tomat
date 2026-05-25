// HTTP contract for /api/v1/pairing. Drives `app.fetch()` directly
// against the real Hono app + real authService. Admin-token paths read
// from paths().adminTokenFile, so we seed it in the tempdir.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";
import { paths } from "../../paths.ts";

const ADMIN_TOKEN = "test-admin-token";

async function seedAdminToken(): Promise<void> {
  await Deno.writeTextFile(paths().adminTokenFile, ADMIN_TOKEN);
  // Mirror the install scripts (core.{sh,ps1}) which write the token
  // 0600 on Unix; tests have to match so future hardening that refuses
  // to read world-readable tokens doesn't pass here while breaking prod.
  if (Deno.build.os !== "windows") {
    await Deno.chmod(paths().adminTokenFile, 0o600);
  }
}

function jsonReq(
  url: string,
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("POST /api/v1/pairing/codes: rejects without admin token (401)", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const res = await app.fetch(jsonReq("http://x/api/v1/pairing/codes", {}));
    assertEquals(res.status, 401);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/codes: mints a 6-digit code with the admin token", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const res = await app.fetch(
      jsonReq("http://x/api/v1/pairing/codes", {}, {
        "x-admin-token": ADMIN_TOKEN,
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(/^\d{6}$/.test(body.code), true);
    assertEquals(typeof body.expiresAtMs, "number");
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/claim: round-trips a real pairing flow", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const mint = await app.fetch(
      jsonReq("http://x/api/v1/pairing/codes", {}, {
        "x-admin-token": ADMIN_TOKEN,
      }),
    );
    const { code } = await mint.json();

    const claim = await app.fetch(
      jsonReq("http://x/api/v1/pairing/claim", {
        code,
        clientName: "my-laptop",
      }),
    );
    assertEquals(claim.status, 200);
    const body = await claim.json();
    assertEquals(typeof body.token, "string");
    assertEquals(typeof body.clientId, "string");
    assertEquals(typeof body.coreVersion, "string");
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/claim: rejects malformed code with 400", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(
      jsonReq("http://x/api/v1/pairing/claim", {
        code: "not-six-digits",
        clientName: "c",
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/pairing/clients: lists the paired client", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const mint = await app.fetch(
      jsonReq("http://x/api/v1/pairing/codes", {}, {
        "x-admin-token": ADMIN_TOKEN,
      }),
    );
    const { code } = await mint.json();
    const claim = await app.fetch(
      jsonReq("http://x/api/v1/pairing/claim", { code, clientName: "L1" }),
    );
    const { token } = await claim.json();
    const list = await app.fetch(
      new Request("http://x/api/v1/pairing/clients", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assertEquals(list.status, 200);
    const body = await list.json();
    assertEquals(body.length, 1);
    assertEquals(body[0].name, "L1");
    assertEquals(body[0].isMe, true);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/rotate: returns a new bearer token", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const mint = await app.fetch(
      jsonReq("http://x/api/v1/pairing/codes", {}, {
        "x-admin-token": ADMIN_TOKEN,
      }),
    );
    const { code } = await mint.json();
    const claim = await app.fetch(
      jsonReq("http://x/api/v1/pairing/claim", { code, clientName: "L" }),
    );
    const { token } = await claim.json();
    const rotate = await app.fetch(
      new Request("http://x/api/v1/pairing/rotate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assertEquals(rotate.status, 200);
    const { token: next } = await rotate.json();
    assertEquals(typeof next, "string");
    assertEquals(next !== token, true);
  } finally {
    await env.teardown();
  }
});
