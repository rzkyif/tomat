// Tier 2: multiple paired cores. The app can hold more than one core and switch
// between them; each core owns its own sessions + settings, so switching swaps
// the whole context. Only this lane proves it: two real cores over real TLS,
// switched through the real cores() registry the CoreBar drives.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { sessionsState } from "@client/state/sessions.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

async function sessionIds(): Promise<string[]> {
  await sessionsState.loadList();
  return sessionsState.list.map((s) => s.id);
}

test("switching cores swaps the session context; each core keeps its own", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "core one reply" } });
  await app.chat.waitReady();

  // Core 1 gets a session.
  await app.chat.send("a message on core one");
  await app.chat.expectText("core one reply");
  const core1Ids = await sessionIds();
  expect(core1Ids.length).toBeGreaterThanOrEqual(1);

  // Pair + switch to a second, independent core (fresh home + DB, own mock LLM).
  const second = await app.pairAnotherCore({ llm: { kind: "text", text: "core two reply" } });
  await app.coreBar.switchTo(second.clientId);
  await app.chat.waitReady();

  // Core 2 is its own world: none of core 1's sessions are visible here.
  const core2Ids = await sessionIds();
  for (const id of core1Ids) expect(core2Ids).not.toContain(id);

  // Give core 2 its own session (answered by core 2's mock), then switch back.
  await app.chat.send("a message on core two");
  await app.chat.expectText("core two reply");
  const core2IdsAfter = await sessionIds();

  // Back to core 1: its sessions return, and core 2's are not present.
  await app.coreBar.switchTo(app.clientId!);
  await app.chat.waitReady();
  const core1Again = await sessionIds();
  for (const id of core1Ids) expect(core1Again).toContain(id);
  for (const id of core2IdsAfter) {
    if (!core1Ids.includes(id)) expect(core1Again).not.toContain(id);
  }
}, 90_000);
