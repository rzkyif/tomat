// Generic HTTP fake sidecar used as a stand-in for any sidecar whose
// readiness check is a 200 on /health (and that doesn't otherwise need to
// speak its real protocol within a test).
//
// Usage:  deno run --allow-net=127.0.0.1 http-stub.ts <port>
// The process serves a 200 "ok" on every path and writes "READY" to stdout
// once the listener is bound, matching the smoke-test contract.

const port = Number(Deno.args[0]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`http-stub: invalid port ${Deno.args[0]}`);
  Deno.exit(2);
}

Deno.serve({ port, hostname: "127.0.0.1" }, () => new Response("ok"));
console.log("READY");
