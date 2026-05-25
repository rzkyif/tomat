// Toolkit, Tool, Permission, Grant — shared shapes used by core + client.
// The on-disk source of truth for permissions is the toolkit's tools.json
// (see validation/tools-json.ts). These types describe the DB-projected
// view that the API serves.

export type ToolkitSource = "npm" | "local";

export type PermissionKind =
  | "net"
  | "read"
  | "write"
  | "run"
  | "env"
  | "ffi"
  | "sys";

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

export type GrantState = "granted" | "denied";

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
  // Indices into `requiredPermissions` that are still missing a granted/denied
  // row in `grants`. A tool is enable-able iff `missingRequired.length === 0`.
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
  contentHash: string;
  enabled: boolean;
  lastError?: string;
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
