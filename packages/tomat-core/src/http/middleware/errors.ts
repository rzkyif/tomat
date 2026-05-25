// Translates thrown errors into the wire-format error envelope. Wired into
// the app via `app.onError()` in server.ts — that's the only Hono 4 hook
// that catches throws from sub-apps mounted via `app.route()`.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorBody, ErrorCode } from "@tomat/shared";
import { AppError, isAppError, isNoSpaceError } from "../../shared/errors.ts";
import { getLogger } from "../../shared/log.ts";

const log = getLogger("http");

export function sendError(c: Context, err: unknown): Response {
  if (isAppError(err)) {
    log.warn(`${c.req.method} ${c.req.path} -> ${err.code}: ${err.message}`);
    return c.json(
      toBody(err.code, err.message, err.details),
      err.status as ContentfulStatusCode,
    );
  }
  if (isNoSpaceError(err)) {
    const message = (err as Error).message;
    log.warn(
      `${c.req.method} ${c.req.path} -> insufficient_storage: ${message}`,
    );
    return c.json(toBody("insufficient_storage", message), 507);
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(`${c.req.method} ${c.req.path} -> internal_error: ${message}`);
  return c.json(toBody("internal_error", message), 500);
}

function toBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export { AppError };
