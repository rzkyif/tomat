// llamaReadinessTimeoutMs: the llama-server readiness window scales with model
// size so a large GGUF on slow hardware isn't false-timed-out into the flap
// guard. Pure function, no I/O.

import { assertEquals } from "@std/assert";
import { llamaReadinessTimeoutMs } from "./llama.ts";

const GiB = 1_073_741_824;

Deno.test("llamaReadinessTimeoutMs: a tiny model still gets the 60s base", () => {
  assertEquals(llamaReadinessTimeoutMs(0), 60_000);
  assertEquals(llamaReadinessTimeoutMs(0.5 * GiB), 60_000 + Math.ceil(0.5 * 25_000));
});

Deno.test("llamaReadinessTimeoutMs: scales ~25s per GiB above the base", () => {
  assertEquals(llamaReadinessTimeoutMs(2 * GiB), 60_000 + 50_000);
  assertEquals(llamaReadinessTimeoutMs(9 * GiB), 60_000 + 225_000);
});

Deno.test("llamaReadinessTimeoutMs: caps so a pathological size can't wait forever", () => {
  assertEquals(llamaReadinessTimeoutMs(100 * GiB), 600_000);
});
