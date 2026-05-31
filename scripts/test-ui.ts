// Runs vitest against tomat-client's Svelte UI suite under Deno.
//
// `npm:vitest` resolves to the version pinned in the client workspace's
// import map (deno.json) + deno.lock because we run from the client dir.

const clientDir =
  new URL("../packages/tomat-client/", import.meta.url).pathname;

// `vitest run` is the non-watch one-shot mode used by CI and by the agent
// workflow. Pass through extra args so `deno task test:ui --reporter=verbose`
// works (callers pass the full vitest arg list, e.g. `run --reporter=verbose`).
const vitestArgs = Deno.args.length > 0 ? Deno.args : ["run"];

const cmd = new Deno.Command("deno", {
  args: ["run", "-A", "npm:vitest", ...vitestArgs],
  cwd: clientDir,
  stdout: "inherit",
  stderr: "inherit",
});
const status = await cmd.output();
Deno.exit(status.code);
