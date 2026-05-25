// Allowlisted CORS. Tomat-core's only browser caller is the Tauri webview
// (origins `tauri://localhost` on mac/linux, `https://tauri.localhost` on
// windows) and the Vite dev server on a loopback port. Native HTTP clients
// (curl, the Tauri rust side, anyone using a raw `fetch` from node) don't
// enforce CORS at all, so omitting CORS headers for them is harmless.
//
// Why this matters even on loopback: we accept `X-Admin-Token` here, which
// is a custom header — without an Origin allowlist, a malicious browser
// page could trigger a CORS preflight to a core bound on 0.0.0.0 and then
// send the token-stealing request. Reflecting `*` plus `X-Admin-Token` in
// Allow-Headers was effectively a wildcard credential grant.

import type { MiddlewareHandler } from "hono";

const ALLOWED_ORIGINS = new Set<string>([
  "tauri://localhost",
  "https://tauri.localhost",
]);

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return LOOPBACK_RE.test(origin);
}

export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && isOriginAllowed(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type,X-Admin-Token",
      );
      c.header("Access-Control-Max-Age", "86400");
    }
    // No Origin header (curl, native HTTP, server-to-server) → no CORS
    // response headers; the request proceeds normally. CORS only gates
    // browser-driven cross-origin fetches.
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  };
}
