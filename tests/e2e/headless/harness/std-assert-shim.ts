// Minimal browser shim for the JSR `@std/assert` module, used by a few shared
// modules that the app graph pulls in. The happy-path browser code never trips
// these, but the symbols must resolve for the npm/vite bundle.

export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assertion failed");
}
export function assertEquals(a: unknown, b: unknown, msg?: string): void {
  if (a !== b) throw new Error(msg ?? `assertEquals failed: ${String(a)} !== ${String(b)}`);
}
export function assertExists<T>(v: T, msg?: string): asserts v is NonNullable<T> {
  if (v === null || v === undefined) throw new Error(msg ?? "assertExists failed");
}
