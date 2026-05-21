// Permissive CORS for loopback. Tomat-core binds 127.0.0.1 (or operator-
// configured host) and is fronted by clients running on the same machine
// or via the user's own TLS reverse proxy; there's no third-party origin
// to lock down at this layer.

import type { MiddlewareHandler } from "hono";

export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,X-Admin-Token",
    );
    c.header("Access-Control-Max-Age", "86400");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  };
}
