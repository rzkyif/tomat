// A minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC
// 2.0). Implements just enough of the protocol for core's MCP client to connect
// and discover one tool, with no npm/jsr fetch (fully hermetic). Run with:
//   deno run fixtures/mcp-server.ts
const enc = new TextEncoder();
function send(msg: unknown): void {
  Deno.stdout.writeSync(enc.encode(JSON.stringify(msg) + "\n"));
}

const TOOLS = [
  {
    name: "ping",
    description: "Returns pong.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: [],
    },
  },
];

function handle(req: {
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: string };
}): void {
  const { id, method } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "pong" }] } });
    return;
  }
  if (method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    return;
  }
  if (method === "resources/list") {
    send({ jsonrpc: "2.0", id, result: { resources: [] } });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  // Notifications (no id) need no response; unknown requests get an error.
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

// Read newline-delimited JSON-RPC from stdin.
async function main(): Promise<void> {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
}

// Fire-and-forget: the pending stdin read keeps the event loop alive, so no
// top-level await is needed (which an import-less Deno script disallows).
void main();
