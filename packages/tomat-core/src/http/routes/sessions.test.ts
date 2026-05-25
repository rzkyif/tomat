// HTTP contract test for /api/v1/sessions. Mounts the real Hono app
// in-memory and drives requests through `app.fetch()` — no socket binding.
// Uses the auth service to mint a real bearer token, then
// exercises the route surface that touches DB + middleware.

import { assertEquals } from "@std/assert";
import { buildApp } from "../server.ts";
import { sanitizeFilename } from "./sessions.ts";
import { authService } from "../../services/auth.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";

async function pairOne(): Promise<{ token: string; clientId: string }> {
  const auth = authService();
  const { code } = await auth.mintPairingCode();
  const { token, clientId } = await auth.claim(
    code,
    "t2-test-client",
    "127.0.0.1",
  );
  return { token, clientId };
}

function bearerHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

Deno.test("GET /api/v1/sessions: rejects requests without a bearer token", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/sessions"));
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error.code, "missing_token");
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/sessions: returns empty list for a freshly-paired client", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/sessions", { headers: bearerHeader(token) }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), []);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /api/v1/sessions then GET: creates and lists the session", async () => {
  const env = await setupTestEnv();
  try {
    const { token, clientId } = await pairOne();
    const app = buildApp();
    const created = await app.fetch(
      new Request("http://x/api/v1/sessions", {
        method: "POST",
        headers: { ...bearerHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ title: "hello-world" }),
      }),
    );
    assertEquals(created.status, 200);
    const session = await created.json();
    assertEquals(session.title, "hello-world");
    assertEquals(session.ownerClientId, clientId);

    const listed = await app.fetch(
      new Request("http://x/api/v1/sessions", { headers: bearerHeader(token) }),
    );
    const list = await listed.json();
    assertEquals(list.length, 1);
    assertEquals(list[0].title, "hello-world");
  } finally {
    await env.teardown();
  }
});

Deno.test("PATCH /api/v1/sessions/:id: rejects when title is missing", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const created = await app.fetch(
      new Request("http://x/api/v1/sessions", {
        method: "POST",
        headers: { ...bearerHeader(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await created.json();
    const res = await app.fetch(
      new Request(`http://x/api/v1/sessions/${session.id}`, {
        method: "PATCH",
        headers: { ...bearerHeader(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
  } finally {
    await env.teardown();
  }
});

Deno.test("DELETE /api/v1/sessions/:id: returns 204 and removes the session from the list", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const created = await app.fetch(
      new Request("http://x/api/v1/sessions", {
        method: "POST",
        headers: { ...bearerHeader(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const session = await created.json();
    const del = await app.fetch(
      new Request(`http://x/api/v1/sessions/${session.id}`, {
        method: "DELETE",
        headers: bearerHeader(token),
      }),
    );
    assertEquals(del.status, 204);
    const listed = await app.fetch(
      new Request("http://x/api/v1/sessions", { headers: bearerHeader(token) }),
    );
    assertEquals(await listed.json(), []);
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/sessions/:id: cross-client access returns 404", async () => {
  const env = await setupTestEnv();
  try {
    // Pair two distinct clients. AuthService.claim takes one pairing code at a
    // time, and mint clears prior unclaimed codes; mint+claim twice.
    const a = await pairOne();
    const b = await pairOne();
    const app = buildApp();
    const created = await app.fetch(
      new Request("http://x/api/v1/sessions", {
        method: "POST",
        headers: {
          ...bearerHeader(a.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "owned-by-a" }),
      }),
    );
    const session = await created.json();
    // b should not be able to read a's session.
    const intruded = await app.fetch(
      new Request(`http://x/api/v1/sessions/${session.id}`, {
        headers: bearerHeader(b.token),
      }),
    );
    assertEquals(intruded.status, 404);
    const body = await intruded.json();
    assertEquals(body.error.code, "session_not_found");
  } finally {
    await env.teardown();
  }
});

Deno.test("GET /api/v1/health: open without auth and returns the running version", async () => {
  const env = await setupTestEnv();
  try {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/v1/health"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "ok");
    assertEquals(typeof body.version, "string");
  } finally {
    await env.teardown();
  }
});

// --- sanitizeFilename ----------------------------------------------------

Deno.test("sanitizeFilename: strips path separators and shell glyphs", () => {
  assertEquals(sanitizeFilename("foo/bar"), "foo_bar");
  assertEquals(sanitizeFilename("..\\foo"), "_foo");
  assertEquals(sanitizeFilename('a:b*c?d"e<f>g|h'), "a_b_c_d_e_f_g_h");
});

Deno.test("sanitizeFilename: strips control chars", () => {
  assertEquals(sanitizeFilename("foo\x00bar\x1fbaz"), "foo_bar_baz");
});

Deno.test("sanitizeFilename: strips leading dots (hidden) and trailing dots/spaces (Windows)", () => {
  assertEquals(sanitizeFilename("...secret.txt"), "secret.txt");
  assertEquals(sanitizeFilename("evil.txt."), "evil.txt");
  assertEquals(sanitizeFilename("evil.txt   "), "evil.txt");
});

Deno.test("sanitizeFilename: prefixes Windows reserved basenames", () => {
  assertEquals(sanitizeFilename("con"), "_con");
  assertEquals(sanitizeFilename("CON.txt"), "_CON.txt");
  assertEquals(sanitizeFilename("LPT9.log"), "_LPT9.log");
  // Non-reserved names that look similar should pass through unchanged.
  assertEquals(sanitizeFilename("console.log"), "console.log");
});

Deno.test("sanitizeFilename: caps length, preserving short extensions", () => {
  const long = "a".repeat(300) + ".jpg";
  const out = sanitizeFilename(long);
  assertEquals(out.length, 200);
  assertEquals(out.endsWith(".jpg"), true);
  // Long pseudo-extensions are not treated as extensions.
  const weird = "b".repeat(150) + "." + "c".repeat(150);
  assertEquals(sanitizeFilename(weird).length, 200);
});

Deno.test("sanitizeFilename: falls back to 'file' when input collapses to empty", () => {
  assertEquals(sanitizeFilename(""), "file");
  assertEquals(sanitizeFilename("..."), "file");
  // Path separators collapse to underscores rather than disappearing, so a
  // string of pure separators stays non-empty.
  assertEquals(sanitizeFilename("///"), "___");
});
