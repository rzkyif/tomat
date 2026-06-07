// HTTP contract for /api/v1/toolkits. Avoids exercising npm install
// (network); the local-install path is verified by installer.t1. Here we
// only assert routing, auth, validation, and the read-only views over a
// tempdir registry.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildApp } from "../server.ts";
import { pairClient } from "../../../tests/helpers/pairing.ts";
import { setupTestEnv } from "../../../tests/helpers/db.ts";
import { toolkitsRegistry } from "../../toolkits/registry.ts";

async function pairOne(): Promise<{ token: string }> {
  const { token } = await pairClient("t2", "127.0.0.1");
  return { token };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function postJson(token: string, path: string): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: "{}",
  });
}

// Seed an INSTALLED toolkit (hash pinned, on-disk folder present) with one tool
// that declares an ungranted net permission. Returns the temp install dir.
async function seedInstalledToolkit(id: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-tk-route-" });
  await Deno.writeTextFile(join(dir, "index.ts"), "export const x = 1;\n");
  const r = toolkitsRegistry();
  r.upsertToolkit({
    id,
    source: "local",
    displayName: id,
    description: "",
    version: "local",
    installedPath: dir,
    toolsJsonHash: "x",
    contentHash: "pinned",
    status: "installed",
  });
  r.replaceTools(id, [
    {
      toolkitId: id,
      name: "t",
      description: "d",
      parameters: { type: "object", properties: {} },
      triggers: [],
      fnExport: "t",
      alwaysAvailable: false,
      requiredPermissions: [{ kind: "net", host: "x", ports: [443], reason: "y" }],
    },
  ]);
  return dir;
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

Deno.test("POST /api/v1/toolkits/embed: 503 server_unavailable when the embed model is absent", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    // Fresh tempdir: no embed model on disk, so the gate trips before the
    // worker is ever spawned (a clean 503 instead of an opaque 500).
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/embed", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ texts: ["hello"] }),
      }),
    );
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error.code, "server_unavailable");
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

Deno.test("POST /api/v1/toolkits/download: unknown source kind returns 400", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/download", {
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

Deno.test("POST /api/v1/toolkits/download: local source requires slug (400)", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/toolkits/download", {
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

Deno.test("POST /api/v1/toolkits/:id/install: 404 for an unknown id", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const app = buildApp();
    const res = await app.fetch(postJson(token, "/api/v1/toolkits/nope/install"));
    assertEquals(res.status, 404);
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /:id/tools/:tool/enable: succeeds even with ungranted required perms", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const id = "tk-enable";
    const dir = await seedInstalledToolkit(id);
    try {
      const app = buildApp();
      const res = await app.fetch(postJson(token, `/api/v1/toolkits/${id}/tools/t/enable`));
      assertEquals(res.status, 200);
      // Enabling is no longer permission-gated; the tool flips on (the
      // chat-exposure gate withholds it from the model until granted).
      assertEquals(toolkitsRegistry().listTools(id)[0].enabled, true);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /:id/tools/enable-all + disable-all: bulk toggle every tool", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const id = "tk-bulk";
    const dir = await seedInstalledToolkit(id);
    try {
      const app = buildApp();
      assertEquals(
        (await app.fetch(postJson(token, `/api/v1/toolkits/${id}/tools/enable-all`))).status,
        200,
      );
      assertEquals(
        toolkitsRegistry()
          .listTools(id)
          .every((t) => t.enabled),
        true,
      );
      assertEquals(
        (await app.fetch(postJson(token, `/api/v1/toolkits/${id}/tools/disable-all`))).status,
        200,
      );
      assertEquals(
        toolkitsRegistry()
          .listTools(id)
          .every((t) => !t.enabled),
        true,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  } finally {
    await env.teardown();
  }
});

Deno.test("POST /:id/confirm-reenable: re-pins hash + clears drift -> installed", async () => {
  const env = await setupTestEnv();
  try {
    const { token } = await pairOne();
    const id = "tk-confirm";
    const dir = await seedInstalledToolkit(id);
    try {
      toolkitsRegistry().markDrift(id);
      assertEquals(toolkitsRegistry().get(id)?.status, "drift");
      const app = buildApp();
      const res = await app.fetch(postJson(token, `/api/v1/toolkits/${id}/confirm-reenable`));
      assertEquals(res.status, 200);
      assertEquals(toolkitsRegistry().get(id)?.status, "installed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
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
