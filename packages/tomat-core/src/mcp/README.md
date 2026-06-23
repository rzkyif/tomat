# MCP servers (core side)

How core connects to Model Context Protocol servers and projects their tools,
prompts, and resources into the rest of tomat. An MCP server is the second kind
of tool provider; the first is an extension
([`../extensions/README.md`](../extensions/README.md)). Core speaks MCP with the
official `@modelcontextprotocol/sdk` client; it never implements the protocol by
hand.

## Connections and transports ([`manager.ts`](manager.ts))

The manager holds one live `Client` per enabled server and owns no persistence.
`sync(servers)` reconciles the live set against the configured one: it connects
every enabled server that isn't connected and disconnects any whose server is
now disabled or gone. Each connect is independent, so one server failing to
start never blocks the others; a failed connect is remembered as an `error`
status with its message.

Two transports, chosen by the server's `kind`:

- **stdio**: a local `command` (plus `args`) the SDK spawns as a subprocess and
  talks to over its stdio (`StdioClientTransport`). The server's `runtime`
  decides how `command` is launched: `custom` spawns it verbatim (`npx`, `node`,
  `uvx`, an absolute path), while `deno` runs it through the bundled deno
  sidecar (`requireWorkerDeno()`), so `command` is a deno run target (an `npm:`
  specifier, a URL, a script) and npm-based servers need no Node.js install.
  The deno runtime grants `--allow-all` when `denoAllowAll` is set (the default,
  for the widest compatibility) or the server's manual `denoPermissions` flags
  otherwise, and its npm/deno cache is contained under the channel's `DENO_DIR`.
- **remote**: an HTTP/SSE `url` reached with `StreamableHTTPClientTransport`. If
  the server stores a bearer token (see below) it is sent as the `Authorization`
  header on every request.

A connect failure is reported with the child's piped stderr appended, so a deno
`PermissionDenied` from a too-narrow manual permission set is visible; a missing
`custom` launcher (`spawn ... ENOENT`) is turned into an actionable hint (install
Node.js or switch to the deno runtime; install the Python tool).

On connect the manager fetches the server's `tools`, `prompts`, and `resources`
and caches them in memory; a server may implement only some of those list
methods, so each list is fetched defensively and defaults to empty. The manager
also exposes `callTool`, `getPrompt`, and `readResource` against a connected
server, each bounded by a request timeout and the turn's abort signal so a
hung server can't stall a turn indefinitely.

`sync()` is serialized so two overlapping CRUD requests can't both spawn the
same server (which would leak a child). `shutdown()` (wired into the core's
signal handler) disconnects every server so spawned stdio children are
terminated rather than orphaned on exit.

### Trust and consent

A stdio server runs an arbitrary local command OUTSIDE the tool sandbox, and a
remote server is an arbitrary endpoint, so enabling a server is the consent gate:
the client confirms before flipping a server on (servers are created disabled),
and the whole server is the trust boundary (MCP tools carry no per-permission
grants, only an enable toggle). Per-tool and per-prompt toggles default off so a
freshly enabled server can't flood tool selection or the `/` menu.

## Registry and projections ([`registry.ts`](registry.ts))

The DB-backed registry is the configured list of servers (`mcp_servers` table)
plus the user's per-tool and per-prompt enablement (stored as JSON sets on the
row). It owns CRUD and the projections the API serves. `project()` merges a
row's stored config with the manager's live `status` and capability counts into
the shared `McpServer` shape. A remote server's bearer token never lives on the
row: only a `has_auth` flag does. The token itself is stored in the secrets
vault under the key from [`secret-key.ts`](secret-key.ts) (the route writes it;
the manager reads it on connect), so it never reaches the DB or the wire
projection.

The capability listings each cross the row's stored enablement with the
manager's in-memory capabilities:

- `listAllTools()` maps every enabled tool from every connected server into the
  shared `Tool` shape (tagged `providerKind: "mcp"`), so MCP tools sit next to
  extension tools in the Tools UI and the same relevance/permission machinery.
- `listPrompts()` returns every prompt with the user's enable flag; an enabled
  prompt becomes a `/`-triggered command.
- `listResources()` returns every resource (all `@`-referenceable).

## Token resolution ([`tokens.ts`](tokens.ts))

`mcpResolveTokens(text)` expands `@resource` and `/prompt` references in a
turn's user message into prompt blocks, fetched live from the server (so it runs
once per turn over the last user message, not per history message; `#` is never
an MCP reference). A `@resource` is injected as fenced reference DATA (the same
contract as knowledge: data, not instructions); a `/prompt`'s messages are
injected as the instructions the server defines. Resources match by slugged
name; only enabled prompts match, and a prompt with a required argument is
skipped (a `/token` carries no arguments). Each block is capped.

It returns the set of token stems it resolved alongside the block; the chat
service hands that set to the memory token expander so a slug that names both an
MCP resource and a memory expands once (MCP wins) instead of twice.

## Routes ([`../http/routes/mcp.ts`](../http/routes/mcp.ts))

The HTTP routes are CRUD for servers, per-tool / per-prompt enable/disable, a
`reconnect` action, and the live `prompts` / `resources` listings the client's
`/` and `@` autocomplete consume. Any change that affects which servers are
enabled calls `resync()`, which has the manager reconcile connections and then
broadcasts an `mcp.snapshot` WS frame so every client repaints.
