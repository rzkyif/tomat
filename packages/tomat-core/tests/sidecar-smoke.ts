// Smoke test for SidecarManager. Spawns a tiny fake "server" subprocess that
// binds 127.0.0.1:7799 and serves /health, then exercises:
//  - start -> Loading -> Running with HTTP readiness
//  - supersession via a second start
//  - graceful stop
//  - status listener fires for each transition

import { sidecarManager } from "../src/sidecars/manager.ts";
import { initLogger } from "../src/shared/log.ts";

await initLogger();

// Write a tiny server script that the manager will spawn.
const SERVER_SCRIPT = `
const port = Number(Deno.args[0]);
Deno.serve({ port, hostname: "127.0.0.1" }, () => new Response("ok"));
console.log("READY");
`;
const scriptPath = await Deno.makeTempFile({ suffix: ".ts" });
await Deno.writeTextFile(scriptPath, SERVER_SCRIPT);

const mgr = sidecarManager();
const events: { ts: number; kind: string; status: string; msg?: string }[] = [];
mgr.subscribe((s) => {
  events.push({
    ts: Date.now(),
    kind: s.kind,
    status: s.status,
    msg: s.message,
  });
  console.log(`> ${s.kind}: ${s.status}${s.message ? ` (${s.message})` : ""}`);
});

const denoBin = Deno.execPath();

console.log("=== start 1 ===");
await mgr.start("llama", {
  binary: denoBin,
  args: ["run", "--allow-net=127.0.0.1:7799", scriptPath, "7799"],
  readiness: { kind: "http", url: "http://127.0.0.1:7799/health" },
  startupTimeoutMs: 10_000,
  restartPolicy: "none",
});

console.log("=== status after start ===");
console.log(mgr.status("llama"));

console.log("=== start 2 (supersedes) ===");
await mgr.start("llama", {
  binary: denoBin,
  args: ["run", "--allow-net=127.0.0.1:7799", scriptPath, "7799"],
  readiness: { kind: "http", url: "http://127.0.0.1:7799/health" },
  startupTimeoutMs: 10_000,
  restartPolicy: "none",
});

console.log("=== status after restart ===");
console.log(mgr.status("llama"));

console.log("=== stop ===");
await mgr.stop("llama");

console.log("=== final status ===");
console.log(mgr.status("llama"));

console.log("=== event log ===");
for (const e of events) {
  console.log(
    `  +${e.ts - events[0].ts}ms ${e.kind}: ${e.status}${
      e.msg ? ` ${e.msg}` : ""
    }`,
  );
}

await Deno.remove(scriptPath);
