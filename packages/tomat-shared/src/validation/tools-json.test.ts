// tools.json is the open-standard contract every toolkit MUST satisfy
// to load into tomat (or any compatible host). This is the test that locks
// down the validator against contract drift.

import { assertEquals } from "@std/assert";
import { parseToolsJson, toolsJsonSchema } from "./tools-json.ts";

const minimalTool = {
  name: "do-thing",
  description: "does a thing",
  parameters: { type: "object", properties: {} },
  function: "doThing",
};

const minimalToolsJson = {
  name: "@example/toolkit",
  description: "example",
  tools: [minimalTool],
};

Deno.test("parseToolsJson: happy path returns ok with defaults applied", () => {
  const result = parseToolsJson(minimalToolsJson);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.tools[0].triggers, []);
    assertEquals(result.value.tools[0].alwaysAvailable, false);
    assertEquals(result.value.tools[0].permissions.net, []);
  }
});

Deno.test("parseToolsJson: rejects empty tools array", () => {
  const result = parseToolsJson({ ...minimalToolsJson, tools: [] });
  assertEquals(result.ok, false);
});

Deno.test("parseToolsJson: rejects unknown top-level fields (strict mode)", () => {
  const result = parseToolsJson({ ...minimalToolsJson, extra: 1 });
  assertEquals(result.ok, false);
});

Deno.test("parseToolsJson: rejects duplicate tool names via superRefine", () => {
  const result = parseToolsJson({
    ...minimalToolsJson,
    tools: [minimalTool, { ...minimalTool }],
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.issues.some((i) => i.message.includes("duplicate tool name")),
      true,
    );
  }
});

Deno.test("parseToolsJson: tool name pattern is enforced", () => {
  for (const name of ["", "has spaces", "name-with-emoji-😀", "x".repeat(65)]) {
    const result = parseToolsJson({
      ...minimalToolsJson,
      tools: [{ ...minimalTool, name }],
    });
    assertEquals(result.ok, false, `should reject name: "${name}"`);
  }
});

Deno.test("parseToolsJson: env key must be SCREAMING_SNAKE_CASE", () => {
  const withEnv = (key: string) => ({
    ...minimalToolsJson,
    tools: [
      {
        ...minimalTool,
        permissions: {
          env: [{ key, reason: "needs it" }],
        },
      },
    ],
  });
  assertEquals(parseToolsJson(withEnv("OPENAI_API_KEY")).ok, true);
  assertEquals(parseToolsJson(withEnv("api_key")).ok, false);
  assertEquals(parseToolsJson(withEnv("kebab-case")).ok, false);
  // Leading digit is rejected by the regex.
  assertEquals(parseToolsJson(withEnv("1FOO")).ok, false);
});

Deno.test("parseToolsJson: net permission accepts numeric ports and '*'", () => {
  const result = parseToolsJson({
    ...minimalToolsJson,
    tools: [
      {
        ...minimalTool,
        permissions: {
          net: [{ host: "api.example.com", ports: [443, "*"], reason: "x" }],
        },
      },
    ],
  });
  assertEquals(result.ok, true);
});

Deno.test("parseToolsJson: net ports out of range are rejected", () => {
  const result = parseToolsJson({
    ...minimalToolsJson,
    tools: [
      {
        ...minimalTool,
        permissions: {
          net: [{ host: "x", ports: [70000], reason: "x" }],
        },
      },
    ],
  });
  assertEquals(result.ok, false);
});

Deno.test("toolsJsonSchema: defaults populate empty permission arrays", () => {
  const result = toolsJsonSchema.safeParse({
    name: "x",
    description: "y",
    tools: [
      {
        name: "t",
        description: "d",
        parameters: {},
        function: "f",
      },
    ],
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.tools[0].permissions.read, []);
    assertEquals(result.data.tools[0].permissions.run, []);
    assertEquals(result.data.tools[0].permissions.documents, []);
    assertEquals(result.data.tools[0].permissions.llm, []);
    assertEquals(result.data.database, false);
  }
});

Deno.test("parseToolsJson: module permissions and the database flag", () => {
  const result = parseToolsJson({
    ...minimalToolsJson,
    database: true,
    tools: [
      {
        ...minimalTool,
        permissions: {
          documents: [{ access: "write", reason: "save notes" }],
          llm: [{ reason: "summarize pages" }],
          tts: [{ reason: "speak results" }],
          stt: [{ reason: "transcribe clips" }],
        },
      },
    ],
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.database, true);
    assertEquals(result.value.tools[0].permissions.documents, [
      { access: "write", reason: "save notes" },
    ]);
    assertEquals(result.value.tools[0].permissions.stt, [{ reason: "transcribe clips" }]);
  }
});

Deno.test("parseToolsJson: documents permission requires a valid access", () => {
  const result = parseToolsJson({
    ...minimalToolsJson,
    tools: [
      {
        ...minimalTool,
        permissions: { documents: [{ access: "admin", reason: "nope" }] },
      },
    ],
  });
  assertEquals(result.ok, false);
});
