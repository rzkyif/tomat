// Barrel export for @tomat/shared.
// API contract types + validation schemas consumed by both tomat-core and tomat-client.

export * from "./api/errors.ts";
export * from "./api/http.ts";
export * from "./api/ws.ts";

export * from "./domain/session.ts";
export * from "./domain/toolkit.ts";
export * from "./domain/model.ts";
export * from "./domain/settings/index.ts";
export * from "./domain/prompts.ts";

export * from "./validation/tools-json.ts";
export * from "./validation/pairing.ts";
export * from "./validation/chat.ts";
export * from "./validation/session.ts";
export * from "./validation/ws.ts";
