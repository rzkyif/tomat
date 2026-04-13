import { Elysia } from "elysia";

// Bind to loopback only — the sidecar is process-private and must never
// accept connections from other hosts on the LAN.
export const app = new Elysia()
  .get("/api/health", () => {
    return { status: "ok" };
  })
  .get("/api/test", () => {
    return { status: "ok" };
  })
  .listen({ port: 7703, hostname: "127.0.0.1" });

console.log(`🦊 Elysia (Minimal) is running at ${app.server?.hostname}:${app.server?.port}`);

export type App = typeof app;
