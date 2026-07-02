// Tier 2: cross-client session isolation, end to end. Two clients pair to the
// SAME core (two real tokens via the PAKE); the core scopes every session to its
// owner (requireOwned), so one client cannot read another's session. Only this
// lane proves it over the real auth + wire.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { cores } from "@client/lib/core/cores.ts";
import { mintCodeWithAdminToken, pairWithCode } from "@client/lib/core/pairing.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a client cannot read another client's session on the same core", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.chat.waitReady();

  // Client A (the app) owns a session.
  const sessionA = await cores().api().sessions.create();

  // Pair a SECOND, independent client to the same core (its own bearer token).
  const { code } = await mintCodeWithAdminToken(app.baseUrl, app.adminToken);
  const clientB = await pairWithCode(app.baseUrl, "client-b", code, false);
  const authB = { authorization: `Bearer ${clientB.token}` };

  // B is a valid client: its own session list is empty (it owns nothing yet).
  const listRes = await fetch(`${app.baseUrl}/api/v1/sessions`, { headers: authB });
  expect(listRes.status).toBe(200);
  expect(((await listRes.json()) as unknown[]).length).toBe(0);

  // B cannot GET A's session: owner-scoped, returns an indistinguishable 404.
  const getRes = await fetch(`${app.baseUrl}/api/v1/sessions/${sessionA.id}`, { headers: authB });
  await getRes.body?.cancel();
  expect(getRes.status).toBe(404);
}, 60_000);
