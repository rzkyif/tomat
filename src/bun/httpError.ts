/** Promoted from `toolkits/service.ts` to this shared module so any route
 *  (TTS, embed, toolkits) can throw a status-carrying error and land on the
 *  single `.onError()` formatter in `index.ts`.
 */

export type HttpError = Error & { status: number };

/** Build an Error annotated with an HTTP status. Throwing this from any
 *  handler routes through the `.onError()` middleware in `index.ts` which
 *  translates it into a `{ error, status }` JSON response. */
export function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}

/** Extract `.status` from an unknown error, falling back to 500 when absent
 *  or out-of-range. Useful when translating non-HttpError throws. */
export function errorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number" && s >= 400 && s < 600) return s;
  }
  return 500;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
