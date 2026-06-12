// Toolkit, Tool, Permission, Grant: shared shapes used by core + client.
// The on-disk source of truth for permissions is the toolkit's tools.json
// (see validation/tools-json.ts). These types describe the DB-projected
// view that the API serves.

export type ToolkitSource = "npm" | "local" | "builtin";

// Gated lifecycle status. `downloaded`: files on disk, deps not installed,
// content hash not pinned. `installed`: deps installed, content hash pinned,
// tools enable-able + (if perms granted) LLM-exposed. `drift`: on-disk content
// no longer matches the pinned hash; all tools auto-disabled until the user
// re-confirms (which re-pins the current content).
export type ToolkitStatus = "downloaded" | "installed" | "drift";

// The built-in toolkit is CDN-distributed (never published to npm) and carries a
// fixed id, which doubles as its on-disk folder name under the toolkits dir. It
// is the package's own name and already satisfies the local-slug charset, so no
// flattening is applied.
export const BUILTIN_TOOLKIT_ID = "tomat-builtin-toolkit";

export type PermissionKind = "net" | "read" | "write" | "run" | "env" | "ffi" | "sys";

// Wire shape mirroring tools.json permission entries. Cardinality varies by
// kind: net entries declare host/ports; read/write declare paths; run declares
// binaries; env declares variable names. ffi/sys are all-or-nothing keys.
export type PermissionDecl =
  | {
      kind: "net";
      host: string;
      ports: ReadonlyArray<number | "*">;
      reason: string;
      optional?: boolean;
    }
  | { kind: "read"; path: string; reason: string; optional?: boolean }
  | { kind: "write"; path: string; reason: string; optional?: boolean }
  | { kind: "run"; binary: string; reason: string; optional?: boolean }
  | { kind: "env"; key: string; reason: string; optional?: boolean }
  | { kind: "ffi"; reason: string; optional?: boolean }
  | { kind: "sys"; flag: string; reason: string; optional?: boolean };

// Stable string key derived from a permission decl, used as the primary key
// in the grants table. See plan §7 for the format per kind.
export function permissionKey(decl: PermissionDecl): string {
  switch (decl.kind) {
    case "net": {
      const portStr = decl.ports.map((p) => String(p)).join(",");
      return `net:${decl.host}:${portStr}`;
    }
    case "read":
      return `read:${decl.path}`;
    case "write":
      return `write:${decl.path}`;
    case "run":
      return `run:${decl.binary}`;
    case "env":
      return `env:${decl.key}`;
    case "ffi":
      return `ffi`;
    case "sys":
      return `sys:${decl.flag}`;
  }
}

// Per-permission decision. `granted` (Always Allow) bakes the permission into
// the worker's --allow-* spawn flags; `ask` leaves it out so Deno prompts at
// the moment of access and the user decides in chat; `denied` auto-rejects the
// prompt. A permission with no grant row behaves as `ask`.
export type GrantState = "granted" | "ask" | "denied";

// Toolkit-level policy for runtime permission prompts that match none of the
// tool's declared permissions: auto-reject or forward to the user.
export type UndeclaredPolicy = "deny" | "ask";

export interface Grant {
  toolId: string;
  permissionKey: string;
  permissionKind: PermissionKind;
  state: GrantState;
  grantedAtMs: number;
}

export interface Tool {
  id: string; // `${toolkitId}::${name}`
  toolkitId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema draft 2020-12
  triggers: string[];
  fnExport: string;
  alwaysAvailable: boolean;
  enabled: boolean;
  requiredPermissions: PermissionDecl[];
  // Indices into `requiredPermissions` that have no grant row yet. Purely
  // informational for the UI: an absent row behaves as `ask`.
  missingRequired: number[];
  grants: Grant[];
}

export interface Toolkit {
  id: string; // npm pkg name (with `@scope/name` flattened to `@scope__name`) or local slug
  source: ToolkitSource;
  displayName: string;
  description?: string;
  version: string;
  installedPath: string;
  toolsJsonHash: string;
  // The pinned trust anchor. Empty string until the toolkit is installed.
  contentHash: string;
  status: ToolkitStatus;
  // Whether the toolkit declares dependencies (deno.json/package.json). Drives
  // the Uninstall vs Delete choice: a no-dep toolkit is installed on download
  // and can only be deleted (there is nothing to uninstall).
  hasDeps: boolean;
  undeclaredPolicy: UndeclaredPolicy;
  // Tool counts from the list/get projection, so a card can show "N enabled"
  // without lazy-loading the full tool list.
  toolCount: number;
  enabledToolCount: number;
  installedAtMs: number;
  updatedAtMs: number;
  // Convenience embedding of tools when fetched via /toolkits/:id/tools.
  tools?: Tool[];
}

// Search-result entry as returned by /api/v1/toolkits/search.
export interface ToolkitSearchResult {
  name: string;
  description: string;
  version: string;
  weeklyDownloads?: number;
  source: "npm";
  homepage?: string;
  license?: string;
}

// OpenAI-format tool schema as returned by /api/v1/toolkits/tool-schemas.
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolDescriptor {
  toolId: string;
  toolkitId: string;
  name: string;
  description: string;
  similarity?: number;
}
