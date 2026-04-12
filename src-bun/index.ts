import { Elysia } from "elysia";

export const app = new Elysia()
  .get("/api/health", () => {
    return { status: "ok" };
  })
  .get("/api/test", () => {
    return { status: "ok" };
  })
  .listen(7703);

console.log(`🦊 Elysia (Minimal) is running at ${app.server?.hostname}:${app.server?.port}`);

export type App = typeof app;
