// HTTP contract for /api/v1/pairing. Drives `app.fetch()` directly against the
// real Hono app + real authService. Admin-token paths read from
// paths().adminTokenFile, so we seed it in the tempdir. The claim flow is a
// CPace PAKE handshake (pake/start + pake/finish); `pakeViaApp` runs the client
// side, and `tlsCertFingerprint()` is the pin a non-MITM client would observe.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";
import { pakeViaApp } from "../../../tests/helpers/pairing.ts";
import { tlsCertFingerprint } from "../../services/tls.ts";
import { paths } from "../../paths.ts";

const ADMIN_TOKEN = "test-admin-token";

async function seedAdminToken(): Promise<void> {
  await Deno.writeTextFile(paths().adminTokenFile, ADMIN_TOKEN);
  // Mirror the install scripts (core.{sh,ps1}) which write the token 0600 on
  // Unix; tests have to match so future hardening that refuses to read
  // world-readable tokens doesn't pass here while breaking prod.
  if (Deno.build.os !== "windows") {
    await Deno.chmod(paths().adminTokenFile, 0o600);
  }
}

function jsonReq(url: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function mintCode(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.fetch(
    jsonReq(
      "http://x/api/v1/pairing/codes",
      {},
      {
        "x-admin-token": ADMIN_TOKEN,
      },
    ),
  );
  const { code } = await res.json();
  return code;
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
      jsonReq(
        "http://x/api/v1/pairing/codes",
        {},
        {
          "x-admin-token": ADMIN_TOKEN,
        },
      ),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(/^\d{6}$/.test(body.code), true);
    assertEquals(typeof body.expiresAtMs, "number");
  } finally {
    await env.teardown();
  }
});

Deno.test("pake: round-trips a real pairing flow and returns a token + confirmS", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const code = await mintCode(app);

    const finish = await pakeViaApp(app, code, "my-laptop", await tlsCertFingerprint());
    assertEquals(finish.status, 200);
    const body = await finish.json();
    assertEquals(typeof body.token, "string");
    assertEquals(typeof body.clientId, "string");
    assertEquals(typeof body.coreVersion, "string");
    assertEquals(typeof body.confirmS, "string");
  } finally {
    await env.teardown();
  }
});

Deno.test("pake: a MITM-substituted cert pin is rejected at finish (401)", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const code = await mintCode(app);

    // The simulated client observed a different cert pin than core's real one.
    const finish = await pakeViaApp(app, code, "mitm-victim", "wrong-cert-pin");
    assertEquals(finish.status, 401);
    const body = await finish.json();
    assertEquals(body.error.code, "invalid_pairing_code");
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/pake/start: rejects a malformed body with 400", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(
      jsonReq("http://x/api/v1/pairing/pake/start", {
        clientName: "c",
        sid: "dmFsaWQ=",
        msgA: "not base64!!",
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
    const code = await mintCode(app);
    const finish = await pakeViaApp(app, code, "L1", await tlsCertFingerprint());
    const { token } = await finish.json();
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

Deno.test("DELETE /api/v1/pairing/clients/:id: a client can remove itself", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const code = await mintCode(app);
    const finish = await pakeViaApp(app, code, "self", await tlsCertFingerprint());
    const { token, clientId } = await finish.json();
    const del = await app.fetch(
      new Request(`http://x/api/v1/pairing/clients/${clientId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assertEquals(del.status, 204);
  } finally {
    await env.teardown();
  }
});

Deno.test("DELETE /api/v1/pairing/clients/:id: a plain client cannot revoke another (401)", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const pin = await tlsCertFingerprint();
    const finishA = await pakeViaApp(app, await mintCode(app), "A", pin);
    const { clientId: idA } = await finishA.json();
    const finishB = await pakeViaApp(app, await mintCode(app), "B", pin);
    const { token: tokenB } = await finishB.json();
    // B (an ordinary paired device) tries to wipe A: rejected without admin.
    const del = await app.fetch(
      new Request(`http://x/api/v1/pairing/clients/${idA}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenB}` },
      }),
    );
    assertEquals(del.status, 401);
    // A is still paired (both clients remain).
    const list = await app.fetch(
      new Request("http://x/api/v1/pairing/clients", {
        headers: { authorization: `Bearer ${tokenB}` },
      }),
    );
    assertEquals((await list.json()).length, 2);
  } finally {
    await env.teardown();
  }
});

Deno.test("DELETE /api/v1/pairing/clients/:id: admin token authorizes cross-device revoke; unknown id is 404", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const pin = await tlsCertFingerprint();
    const finishA = await pakeViaApp(app, await mintCode(app), "A", pin);
    const { clientId: idA } = await finishA.json();
    const finishB = await pakeViaApp(app, await mintCode(app), "B", pin);
    const { token: tokenB } = await finishB.json();
    const headers = {
      authorization: `Bearer ${tokenB}`,
      "x-admin-token": ADMIN_TOKEN,
    };
    const del = await app.fetch(
      new Request(`http://x/api/v1/pairing/clients/${idA}`, {
        method: "DELETE",
        headers,
      }),
    );
    assertEquals(del.status, 204);
    // Revoking the now-unknown id again is a 404, not a silent 204.
    const again = await app.fetch(
      new Request(`http://x/api/v1/pairing/clients/${idA}`, {
        method: "DELETE",
        headers,
      }),
    );
    assertEquals(again.status, 404);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/pairing/rotate: returns a new bearer token", async () => {
  const env = await setupTestEnv();
  try {
    await seedAdminToken();
    const app = buildApp();
    const code = await mintCode(app);
    const finish = await pakeViaApp(app, code, "L", await tlsCertFingerprint());
    const { token } = await finish.json();
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
