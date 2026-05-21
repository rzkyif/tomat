// Derive the Deno `--allow-*` flag set from the granted permissions for the
// set of currently-enabled tools in a toolkit.
//
// Per the plan: spawn flags are computed from the UNION of grants for
// enabled tools. Optional ungranted permissions are silently absent (the
// tool sees a NotCapable at runtime and handles or fails gracefully).

import type { Grant, PermissionDecl, PermissionKind } from "@tomat/shared";

export interface FlagSet {
  net: Set<string>; // host:port entries
  read: Set<string>;
  write: Set<string>;
  run: Set<string>;
  env: Set<string>;
  ffi: boolean;
  sys: Set<string>;
}

export function emptyFlagSet(): FlagSet {
  return {
    net: new Set(),
    read: new Set(),
    write: new Set(),
    run: new Set(),
    env: new Set(),
    ffi: false,
    sys: new Set(),
  };
}

export interface ToolGrantContext {
  // Declared permissions for the tool (parsed from tools.json).
  required: PermissionDecl[];
  // Stored grants for the tool (only entries with state="granted" contribute).
  grants: Grant[];
}

// Compose the union flag set across an array of (decl, grant) contexts.
// Per-permission keys must appear in both `required` and `grants` (granted
// state) to contribute. Unknown grant keys are ignored — they're stale
// holdovers from a previous tools.json version.
export function unionFlags(
  tools: ToolGrantContext[],
  templates: PathTemplates,
): FlagSet {
  const out = emptyFlagSet();
  for (const tool of tools) {
    const grantedKeys = new Set(
      tool.grants.filter((g) => g.state === "granted").map((g) =>
        g.permissionKey
      ),
    );
    for (const decl of tool.required) {
      const key = declKey(decl);
      if (!grantedKeys.has(key)) continue;
      applyDecl(out, decl, templates);
    }
  }
  return out;
}

export function flagSetToArgs(flags: FlagSet): string[] {
  const args: string[] = [];
  if (flags.read.size > 0) {
    args.push(`--allow-read=${[...flags.read].join(",")}`);
  }
  if (flags.write.size > 0) {
    args.push(`--allow-write=${[...flags.write].join(",")}`);
  }
  if (flags.net.size > 0) args.push(`--allow-net=${[...flags.net].join(",")}`);
  if (flags.env.size > 0) args.push(`--allow-env=${[...flags.env].join(",")}`);
  if (flags.run.size > 0) args.push(`--allow-run=${[...flags.run].join(",")}`);
  if (flags.ffi) args.push("--allow-ffi");
  if (flags.sys.size > 0) args.push(`--allow-sys=${[...flags.sys].join(",")}`);
  return args;
}

// Template substitutions applied to read/write paths at spawn time.
// `$home`, `$downloads`, `$models`, `$sessions`, `$toolkit`, `$env.VAR`.
export interface PathTemplates {
  home: string;
  downloads: string;
  models: string;
  sessions: string;
  toolkit: string;
}

export function expandPath(template: string, templates: PathTemplates): string {
  return template
    .replaceAll("$home", templates.home)
    .replaceAll("$downloads", templates.downloads)
    .replaceAll("$models", templates.models)
    .replaceAll("$sessions", templates.sessions)
    .replaceAll("$toolkit", templates.toolkit)
    .replace(/\$env\.([A-Z_][A-Z0-9_]*)/g, (_, key) => Deno.env.get(key) ?? "");
}

function applyDecl(
  flags: FlagSet,
  decl: PermissionDecl,
  templates: PathTemplates,
): void {
  switch (decl.kind) {
    case "net": {
      for (const port of decl.ports) {
        flags.net.add(`${decl.host}:${port}`);
      }
      break;
    }
    case "read":
      flags.read.add(expandPath(decl.path, templates));
      break;
    case "write":
      flags.write.add(expandPath(decl.path, templates));
      break;
    case "run":
      flags.run.add(decl.binary);
      break;
    case "env":
      flags.env.add(decl.key);
      break;
    case "ffi":
      flags.ffi = true;
      break;
    case "sys":
      flags.sys.add(decl.flag);
      break;
  }
}

function declKey(decl: PermissionDecl): string {
  switch (decl.kind) {
    case "net":
      return `net:${decl.host}:${decl.ports.map(String).join(",")}`;
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

// Map between PermissionKind and the DB column representation.
export function permissionKindOf(decl: PermissionDecl): PermissionKind {
  return decl.kind;
}
