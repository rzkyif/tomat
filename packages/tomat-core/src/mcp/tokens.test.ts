// MCP token resolution: @resource -> fenced reference DATA, /prompt ->
// instruction block, slug matching, dedup via the claimed set, required-argument
// prompts skipped, `#` never treated as a reference, and the per-block cap.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mcpResolveTokens } from "./tokens.ts";
import { mcpRegistry } from "./registry.ts";
import { mcpManager } from "./manager.ts";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { clearFakeMcpServers, installFakeMcpServer } from "../../tests/helpers/mcp.ts";

async function connectFake(spec: Parameters<typeof installFakeMcpServer>[1]): Promise<string> {
  const s = mcpRegistry().create({ name: "Fake", kind: "stdio", command: "fake", enabled: true });
  installFakeMcpServer(s.id, spec);
  await mcpManager().sync(mcpRegistry().list());
  return s.id;
}

Deno.test("resolves @resource as fenced reference DATA", async () => {
  const env = await setupTestEnv();
  try {
    await connectFake({
      resources: [{ name: "My Notes", uri: "mem://notes", text: "secret plan" }],
    });
    // Slug match: "My Notes" -> @my-notes.
    const { block, claimed } = await mcpResolveTokens("see @my-notes please");
    assert(block);
    assertStringIncludes(block, "reference DATA only");
    assertStringIncludes(block, "secret plan");
    assertEquals(claimed.has("my-notes"), true);
  } finally {
    await clearFakeMcpServers();
    await env.teardown();
  }
});

Deno.test("resolves /prompt as an instruction block, only when enabled", async () => {
  const env = await setupTestEnv();
  try {
    const id = await connectFake({ prompts: [{ name: "commit", text: "Write a commit message" }] });
    // Disabled by default: no match.
    assertEquals((await mcpResolveTokens("run /commit")).block, null);
    mcpRegistry().setPromptEnabled(id, "commit", true);
    const { block } = await mcpResolveTokens("run /commit");
    assert(block);
    assertStringIncludes(block, "follow these instructions");
    assertStringIncludes(block, "Write a commit message");
  } finally {
    await clearFakeMcpServers();
    await env.teardown();
  }
});

Deno.test("dedups a repeated token and ignores '#'", async () => {
  const env = await setupTestEnv();
  try {
    await connectFake({ resources: [{ name: "readme", uri: "file:///r", text: "DOC" }] });
    const { block } = await mcpResolveTokens("@readme then @readme again, not #readme");
    assert(block);
    // One block only despite two @readme mentions.
    assertEquals(block.split("BEGIN RESOURCE").length - 1, 1);
  } finally {
    await clearFakeMcpServers();
    await env.teardown();
  }
});

Deno.test("skips a prompt that needs a required argument", async () => {
  const env = await setupTestEnv();
  try {
    const id = await connectFake({
      prompts: [{ name: "review", requiredArg: true, text: "Review {{topic}}" }],
    });
    mcpRegistry().setPromptEnabled(id, "review", true);
    assertEquals((await mcpResolveTokens("do /review")).block, null);
  } finally {
    await clearFakeMcpServers();
    await env.teardown();
  }
});

Deno.test("caps a large resource body", async () => {
  const env = await setupTestEnv();
  try {
    await connectFake({
      resources: [{ name: "big", uri: "file:///big", text: "x".repeat(100_000) }],
    });
    const { block } = await mcpResolveTokens("@big");
    assert(block);
    // The body is sliced to 64k; the surrounding fence adds a small constant.
    assert(block.length < 65_000, `block too long: ${block.length}`);
  } finally {
    await clearFakeMcpServers();
    await env.teardown();
  }
});
