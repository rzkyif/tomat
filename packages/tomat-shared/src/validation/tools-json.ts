// Canonical tools.json schema (open standard). Parsed by core's installer to
// validate every toolkit at install time and re-validated on hash drift.
//
// Per the plan, tools.json carries no tomat-specific marker. Any package
// shipping a valid tools.json is a valid toolkit for any compatible host.

import { z } from "zod";

const reasonField = z.string().min(1).max(500);

const portSchema = z.union([z.number().int().min(1).max(65535), z.literal("*")]);

const netPermission = z.object({
  host: z.string().min(1),
  ports: z.array(portSchema).min(1),
  reason: reasonField,
  optional: z.boolean().optional(),
});

const pathPermission = z.object({
  path: z.string().min(1),
  reason: reasonField,
  optional: z.boolean().optional(),
});

const runPermission = z.object({
  binary: z.string().min(1),
  reason: reasonField,
  optional: z.boolean().optional(),
});

const envPermission = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[A-Z_][A-Z0-9_]*$/, {
      message: "env key must be SCREAMING_SNAKE_CASE",
    }),
  reason: reasonField,
  optional: z.boolean().optional(),
});

const ffiPermission = z.object({
  reason: reasonField,
  optional: z.boolean().optional(),
});

const sysPermission = z.object({
  flag: z.string().min(1),
  reason: reasonField,
  optional: z.boolean().optional(),
});

// Host-module permissions (memory store, LLM, TTS, STT) enforced by the
// host's module broker rather than the sandbox runtime. All-or-nothing keys
// except memories, which splits into read/write access.
const memoriesPermission = z.object({
  access: z.enum(["read", "write"]),
  reason: reasonField,
  optional: z.boolean().optional(),
});

const modulePermission = z.object({
  reason: reasonField,
  optional: z.boolean().optional(),
});

export const toolPermissionsSchema = z
  .object({
    net: z.array(netPermission).default([]),
    read: z.array(pathPermission).default([]),
    write: z.array(pathPermission).default([]),
    run: z.array(runPermission).default([]),
    env: z.array(envPermission).default([]),
    ffi: z.array(ffiPermission).default([]),
    sys: z.array(sysPermission).default([]),
    memories: z.array(memoriesPermission).default([]),
    llm: z.array(modulePermission).default([]),
    tts: z.array(modulePermission).default([]),
    stt: z.array(modulePermission).default([]),
  })
  .strict();

export type ToolPermissionsDecl = z.infer<typeof toolPermissionsSchema>;

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

export const toolSchema = z
  .object({
    name: z.string().regex(toolNamePattern, {
      message: "tool name must match ^[a-zA-Z0-9_-]{1,64}$",
    }),
    description: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    triggers: z.array(z.string()).default([]),
    function: z.string().min(1),
    alwaysAvailable: z.boolean().default(false),
    permissions: toolPermissionsSchema.default({
      net: [],
      read: [],
      write: [],
      run: [],
      env: [],
      ffi: [],
      sys: [],
      memories: [],
      llm: [],
      tts: [],
      stt: [],
    }),
  })
  .strict();

export type ToolDecl = z.infer<typeof toolSchema>;

export const toolsJsonSchema = z
  .object({
    $schema: z.string().url().optional(),
    name: z.string().min(1),
    description: z.string().min(1),
    license: z.string().optional(),
    homepage: z.string().url().optional(),
    // Whether the host should provision a private database for this toolkit
    // (exposed to tools as `ctx.db`). Storage is host-defined.
    database: z.boolean().default(false),
    tools: z.array(toolSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (let i = 0; i < value.tools.length; i++) {
      const name = value.tools[i].name;
      if (names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", i, "name"],
          message: `duplicate tool name "${name}" within toolkit`,
        });
      }
      names.add(name);
    }
  });

export type ToolsJson = z.infer<typeof toolsJsonSchema>;

export interface ToolsJsonParseError {
  ok: false;
  message: string;
  issues: Array<{ path: (string | number)[]; message: string }>;
}

export interface ToolsJsonParseOk {
  ok: true;
  value: ToolsJson;
}

export type ToolsJsonParseResult = ToolsJsonParseOk | ToolsJsonParseError;

export function parseToolsJson(input: unknown): ToolsJsonParseResult {
  const result = toolsJsonSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    message: result.error.message,
    issues: result.error.issues.map((i) => ({
      path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
      message: i.message,
    })),
  };
}
