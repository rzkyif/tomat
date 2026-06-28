import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type McpDetailView from "../components/settings/McpDetailView.svelte";

// The MCP server detail editor: the enable toggle + status line, the name and
// transport fields, the transport-specific fields (stdio command/args with the
// optional bundled-deno runtime and its permissions, or a remote URL + bearer
// token), and the live prompts list. Each sample drives one shape: a custom
// stdio command, the bundled-deno runtime with manual permissions, a remote
// HTTP server with a stored token, an error status, and a server exposing
// prompts.
export const mcpDetailSamples = {
  stdioCustom: {
    enabled: true,
    status: "connected",
    draftName: "Filesystem",
    draftKind: "stdio",
    draftCommand: "npx",
    draftArgs: "-y @modelcontextprotocol/server-filesystem /Users/me",
    draftRuntime: "custom",
    draftAllowAll: true,
    draftPermissions: "",
    draftUrl: "",
    draftAuthToken: "",
  },
  stdioDeno: {
    enabled: false,
    status: "disconnected",
    draftName: "Memory",
    draftKind: "stdio",
    draftCommand: "npm:@modelcontextprotocol/server-memory",
    draftArgs: "",
    draftRuntime: "deno",
    draftAllowAll: false,
    draftPermissions: "--allow-net --allow-read=/Users/me/notes",
    draftUrl: "",
    draftAuthToken: "",
  },
  remoteWithToken: {
    enabled: true,
    status: "connected",
    remoteAuth: "bearer",
    hasAuth: true,
    draftName: "Linear",
    draftKind: "remote",
    draftCommand: "",
    draftArgs: "",
    draftRuntime: "custom",
    draftAllowAll: true,
    draftPermissions: "",
    draftUrl: "https://mcp.linear.app/sse",
    draftAuthToken: "",
  },
  remoteOAuth: {
    enabled: true,
    status: "error",
    statusError: "OAuth sign-in required",
    remoteAuth: "oauth",
    oauthAuthorized: false,
    draftName: "GitHub",
    draftKind: "remote",
    draftCommand: "",
    draftArgs: "",
    draftRuntime: "custom",
    draftAllowAll: true,
    draftPermissions: "",
    draftUrl: "https://api.githubcopilot.com/mcp",
    draftAuthToken: "",
  },
  error: {
    enabled: true,
    status: "error",
    statusError: "Connection refused: spawn npx ENOENT",
    draftName: "Broken Server",
    draftKind: "stdio",
    draftCommand: "npx",
    draftArgs: "-y @some/missing-server",
    draftRuntime: "custom",
    draftAllowAll: true,
    draftPermissions: "",
    draftUrl: "",
    draftAuthToken: "",
  },
  withPrompts: {
    enabled: true,
    status: "connected",
    draftName: "Git",
    draftKind: "stdio",
    draftCommand: "uvx",
    draftArgs: "mcp-server-git",
    draftRuntime: "custom",
    draftAllowAll: true,
    draftPermissions: "",
    draftUrl: "",
    draftAuthToken: "",
    prompts: [
      { name: "commit", description: "Draft a commit message from staged changes.", enabled: true },
      { name: "review", description: "Review the current diff for issues.", enabled: false },
    ],
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof McpDetailView>>>;
