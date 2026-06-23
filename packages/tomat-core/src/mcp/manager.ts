// MCP connection manager: one client per enabled server. Connects over stdio
// (spawned subprocess) or remote streamable HTTP, fetches each server's
// tools/prompts/resources on connect, and exposes call/getPrompt/readResource.
// Capabilities are cached in memory; the registry merges them with the DB rows
// to project McpServer/McpPrompt/McpResource. The manager owns no persistence.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnectionStatus, McpServer } from "@tomat/shared";
import { errMessage } from "@tomat/shared";
import { getLogger } from "../shared/log.ts";
import { getSecret } from "../services/secrets.ts";
import { mcpAuthSecretName } from "./secret-key.ts";
import { requireWorkerDeno } from "../sidecars/worker-deno.ts";
import { paths } from "../paths.ts";

const log = getLogger("mcp");

// A single MCP request (tool call, prompt fetch, resource read) must not hang
// the turn forever if a server accepts the connection but never responds. The
// SDK aborts the request when this elapses; callers fold the rejection into a
// failed tool result / dropped token rather than crashing the turn.
const REQUEST_TIMEOUT_MS = 30_000;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface Connection {
  client: Client;
  status: McpConnectionStatus;
  error?: string;
  tools: McpToolDef[];
  prompts: McpPromptDef[];
  resources: McpResourceDef[];
}

class McpManager {
  private conns = new Map<string, Connection>();
  // Status for servers that failed to connect (no live client).
  private failed = new Map<string, string>();
  // Servers whose connect() is in flight, so status() can report "connecting".
  private connecting = new Set<string>();
  // Serializes sync() so two overlapping CRUD requests can't both pass the
  // `conns.has` guard in connect() and spawn the same server twice (the second
  // would overwrite the first connection and leak its child process).
  private syncChain: Promise<void> = Promise.resolve();

  status(id: string): { status: McpConnectionStatus; error?: string } {
    const c = this.conns.get(id);
    if (c) return { status: c.status, error: c.error };
    if (this.connecting.has(id)) return { status: "connecting" };
    if (this.failed.has(id)) {
      return { status: "error", error: this.failed.get(id) };
    }
    return { status: "disconnected" };
  }

  capabilities(id: string): Pick<Connection, "tools" | "prompts" | "resources"> {
    const c = this.conns.get(id);
    return c
      ? { tools: c.tools, prompts: c.prompts, resources: c.resources }
      : { tools: [], prompts: [], resources: [] };
  }

  /** Connect every enabled server that isn't connected, and disconnect any
   *  connection whose server is now disabled or gone. Called on boot and after
   *  any server CRUD. Each connect is independent; one failure doesn't block
   *  the others. */
  sync(servers: McpServer[]): Promise<void> {
    // Chain onto the previous sync (run it even if the previous rejected) so
    // only one reconciliation touches `conns` at a time. Each call reconciles
    // against the latest desired state passed in.
    this.syncChain = this.syncChain.catch(() => {}).then(() => this.doSync(servers));
    return this.syncChain;
  }

  private async doSync(servers: McpServer[]): Promise<void> {
    const enabled = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));
    // Drop connections no longer wanted. Deleting the current key from a Map
    // during for-of iteration is safe (the spec won't revisit it).
    for (const id of this.conns.keys()) {
      if (!enabled.has(id)) await this.disconnect(id);
    }
    for (const id of this.failed.keys()) {
      if (!enabled.has(id)) this.failed.delete(id);
    }
    // Bring up newly enabled ones.
    await Promise.all(
      [...enabled.values()].filter((s) => !this.conns.has(s.id)).map((s) => this.connect(s)),
    );
  }

  async connect(server: McpServer): Promise<void> {
    if (this.conns.has(server.id)) return;
    this.failed.delete(server.id);
    this.connecting.add(server.id);
    const client = new Client(
      { name: "tomat", version: "0.1.0" },
      {
        capabilities: {},
      },
    );
    try {
      const transport = await makeTransport(server);
      const readStderr = captureStderr(transport);
      await client.connect(transport).catch((err: unknown) => {
        // Spawn/handshake failure: fold in whatever the child printed to stderr
        // (a deno PermissionDenied from a too-narrow manual permission set, a
        // missing module) and map a missing launcher to an actionable hint, so
        // the user sees why instead of a bare "connection closed".
        throw new Error(describeConnectError(server, err, readStderr()));
      });
      const conn: Connection = {
        client,
        status: "connected",
        tools: [],
        prompts: [],
        resources: [],
      };
      // Fetch capabilities; a server may not implement every list method.
      conn.tools = await safeList(
        () => client.listTools(),
        (r) => (r as { tools: McpToolDef[] }).tools,
      );
      conn.prompts = await safeList(
        () => client.listPrompts(),
        (r) =>
          (r as { prompts: McpPromptDef[] }).prompts.map((p) => ({
            ...p,
            arguments: p.arguments ?? [],
          })),
      );
      conn.resources = await safeList(
        () => client.listResources(),
        (r) => (r as { resources: McpResourceDef[] }).resources,
      );
      this.conns.set(server.id, conn);
      log.info(
        `connected ${server.name}: ${conn.tools.length} tools, ${conn.prompts.length} prompts, ` +
          `${conn.resources.length} resources`,
      );
    } catch (err) {
      this.failed.set(server.id, errMessage(err));
      try {
        await client.close();
      } catch {
        /* best effort */
      }
      log.warn(`connect ${server.name} failed: ${errMessage(err)}`);
    } finally {
      this.connecting.delete(server.id);
    }
  }

  async disconnect(id: string): Promise<void> {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    try {
      await c.client.close();
    } catch {
      /* best effort */
    }
  }

  private clientOrThrow(id: string): Client {
    const c = this.conns.get(id);
    if (!c) throw new Error(`MCP server ${id} is not connected`);
    return c.client;
  }

  callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.clientOrThrow(serverId).callTool({ name, arguments: args }, undefined, {
      timeout: REQUEST_TIMEOUT_MS,
      signal,
    });
  }

  getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ messages: Array<{ role: string; content: unknown }> }> {
    return this.clientOrThrow(serverId).getPrompt(
      { name, arguments: args },
      { timeout: REQUEST_TIMEOUT_MS, signal },
    ) as Promise<{
      messages: Array<{ role: string; content: unknown }>;
    }>;
  }

  readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }> {
    return this.clientOrThrow(serverId).readResource(
      { uri },
      { timeout: REQUEST_TIMEOUT_MS, signal },
    ) as Promise<{
      contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
    }>;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }
}

async function makeTransport(server: McpServer) {
  if (server.kind === "stdio") {
    // The deno runtime runs the command through the bundled deno binary, so
    // npm-based servers need no Node.js install; custom runs it verbatim.
    if (server.runtime === "deno") return await makeDenoStdioTransport(server);
    if (!server.command) throw new Error("stdio MCP server has no command");
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      stderr: "pipe",
    });
  }
  if (!server.url) throw new Error("remote MCP server has no url");
  // Send the stored bearer token (if any) as the Authorization header on every
  // request. The token lives in the secrets vault, keyed by server id; it never
  // touches the DB or the wire projection.
  let requestInit: RequestInit | undefined;
  if (server.hasAuth) {
    const token = await getSecret(mcpAuthSecretName(server.id));
    if (token) {
      requestInit = { headers: { Authorization: `Bearer ${token}` } };
    }
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
}

/** Build a stdio transport that runs the server through the bundled deno binary.
 *  `command` is the deno run target (an npm: specifier, URL, or script); the
 *  permission flags come from the server's allow-all toggle or manual list. */
async function makeDenoStdioTransport(server: McpServer): Promise<StdioClientTransport> {
  const target = server.command?.trim();
  if (!target) throw new Error("deno MCP server has no package or script to run");
  const denoBin = await requireWorkerDeno();
  const perms = server.denoAllowAll ? ["--allow-all"] : server.denoPermissions;
  return new StdioClientTransport({
    command: denoBin,
    args: ["run", ...perms, target, ...server.args],
    // Contain the npm/deno cache under tomat's channel dir rather than the
    // user's global cache. The SDK merges this over a safe default env that
    // already carries PATH and HOME.
    env: { DENO_DIR: paths().denoCacheDir },
    stderr: "pipe",
  });
}

/** Drain a stdio transport's piped stderr so a connect failure can report what
 *  the child actually printed. The SDK exposes the stderr PassThrough before
 *  start(), so attaching here loses no early output. */
function captureStderr(transport: { stderr?: unknown }): () => string {
  const stream = transport.stderr;
  if (!stream || typeof (stream as { on?: unknown }).on !== "function") return () => "";
  const chunks: string[] = [];
  let len = 0;
  (stream as { on(event: "data", cb: (chunk: unknown) => void): void }).on("data", (chunk) => {
    if (len >= STDERR_CAP) return;
    const s = String(chunk);
    chunks.push(s);
    len += s.length;
  });
  return () => chunks.join("").trim();
}
const STDERR_CAP = 4000;

/** Turn a connect failure into a user-facing status. A missing custom launcher
 *  gets an actionable hint; otherwise the child's stderr tail is appended. */
function describeConnectError(server: McpServer, err: unknown, stderrTail: string): string {
  if (server.kind === "stdio" && server.runtime === "custom" && isCommandNotFound(err)) {
    return launcherUnavailableMessage(server.command ?? "");
  }
  const base = errMessage(err);
  return stderrTail ? `${base}: ${stderrTail}` : base;
}

function isCommandNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT") return true;
  return /\bENOENT\b/.test(errMessage(err));
}

// Launchers that ship with Node.js / a Python tool, so a "not found" can point
// the user somewhere concrete instead of a bare "command not found".
const NODE_LAUNCHERS = new Set(["npx", "npm", "node", "bunx", "bun", "yarn", "pnpm"]);
const PYTHON_LAUNCHERS = new Set(["uvx", "uv", "pipx", "python", "python3"]);

function launcherUnavailableMessage(command: string): string {
  const name = launcherBasename(command);
  if (NODE_LAUNCHERS.has(name)) {
    return (
      `"${name}" was not found. Install Node.js, or switch Runtime to ` +
      `Bundled deno and set Package or Script to an npm specifier (for example ` +
      `npm:@scope/server), which runs many npm-based MCP servers without Node.js.`
    );
  }
  if (PYTHON_LAUNCHERS.has(name)) {
    return `"${name}" was not found. Install it to run this MCP server.`;
  }
  return `"${name}" was not found on this machine. Check the command or install it.`;
}

function launcherBasename(command: string): string {
  const base = command.trim().split(/[/\\]/).pop() ?? command.trim();
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

async function safeList<R, T>(call: () => Promise<R>, pick: (r: R) => T[]): Promise<T[]> {
  try {
    return pick(await call());
  } catch {
    return [];
  }
}

let _instance: McpManager | null = null;
export function mcpManager(): McpManager {
  if (!_instance) _instance = new McpManager();
  return _instance;
}
