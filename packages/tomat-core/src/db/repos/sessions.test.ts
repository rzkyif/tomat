// SessionsRepo CRUD + the cross-client tenancy guarantee that the
// owner_client_id WHERE clauses are supposed to enforce. Skips message and
// attachment edge cases that are sufficiently covered by the chat.ts
// integration test. Keep this slim.

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import type { Message } from "@tomat/shared";
import { sessionsRepo } from "./sessions.ts";
import { createTestClient, setupTestEnv } from "../../../tests/helpers/db.ts";
import { newMessageId } from "../../shared/ids.ts";
import { AppError } from "../../shared/errors.ts";

function userMessage(content = "hello"): Message {
  return {
    id: newMessageId(),
    ord: 0,
    role: "user",
    content,
    createdAtMs: Date.now(),
  };
}

Deno.test("SessionsRepo.create: returns session with id, timestamps, and default title", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const client = createTestClient();
    const s = repo.create({ ownerClientId: client });
    assertEquals(s.ownerClientId, client);
    assertEquals(s.title, "");
    assertEquals(typeof s.id, "string");
    assertEquals(s.createdAtMs, s.updatedAtMs);
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.list: only returns sessions owned by the caller", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const a = createTestClient("a");
    const b = createTestClient("b");
    repo.create({ ownerClientId: a, title: "a-1" });
    repo.create({ ownerClientId: a, title: "a-2" });
    repo.create({ ownerClientId: b, title: "b-1" });
    const aList = repo.list(a);
    const bList = repo.list(b);
    assertEquals(aList.length, 2);
    assertEquals(bList.length, 1);
    assertEquals(bList[0].title, "b-1");
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.getOrThrow: rejects access from a non-owner client", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const intruder = createTestClient("intruder");
    const s = repo.create({ ownerClientId: owner });
    // Owner can read; intruder cannot.
    repo.getOrThrow(owner, s.id);
    assertThrows(() => repo.getOrThrow(intruder, s.id), AppError);
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.patchTitle: persists across reads and updates updated_at", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const s = repo.create({ ownerClientId: owner });
    const before = repo.getOrThrow(owner, s.id).updatedAtMs;
    // Ensure measurable clock movement.
    await new Promise((r) => setTimeout(r, 5));
    repo.patchTitle(owner, s.id, "renamed");
    const after = repo.getOrThrow(owner, s.id);
    assertEquals(after.title, "renamed");
    assertNotEquals(before, after.updatedAtMs);
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.delete: removes and rejects subsequent reads", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const s = repo.create({ ownerClientId: owner });
    const { attachmentPaths } = repo.delete(owner, s.id);
    assertEquals(attachmentPaths, []);
    assertThrows(() => repo.getOrThrow(owner, s.id), AppError);
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.delete: rejects when invoked from a non-owner client", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const intruder = createTestClient("intruder");
    const s = repo.create({ ownerClientId: owner });
    assertThrows(() => repo.delete(intruder, s.id), AppError);
    // Original session is untouched.
    repo.getOrThrow(owner, s.id);
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo.appendMessage + listMessages: round-trips message in order", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const s = repo.create({ ownerClientId: owner });
    repo.appendMessage(s.id, userMessage("first"));
    repo.appendMessage(s.id, userMessage("second"));
    const msgs = repo.listMessages(s.id);
    assertEquals(msgs.length, 2);
    assertEquals(msgs[0].ord < msgs[1].ord, true);
    assertEquals((msgs[0] as { content: string }).content, "first");
    assertEquals((msgs[1] as { content: string }).content, "second");
  } finally {
    await env.teardown();
  }
});

Deno.test("SessionsRepo: deleting a session cascades to its messages", async () => {
  const env = await setupTestEnv();
  try {
    const repo = sessionsRepo();
    const owner = createTestClient("owner");
    const s = repo.create({ ownerClientId: owner });
    repo.appendMessage(s.id, userMessage("doomed"));
    repo.delete(owner, s.id);
    // After cascade, listing messages on a deleted session must return [].
    assertEquals(repo.listMessages(s.id), []);
  } finally {
    await env.teardown();
  }
});
