// permission flag-set composition. Pure logic — no I/O, no DB.
// Verifies the union semantics that drive `--allow-*` args at worker spawn.

import { assertEquals } from "@std/assert";
import type { Grant, PermissionDecl } from "@tomat/shared";
import { permissionKey } from "@tomat/shared";
import {
  emptyFlagSet,
  expandPath,
  flagSetToArgs,
  type PathTemplates,
  unionFlags,
} from "./permissions.ts";

const templates: PathTemplates = {
  home: "/home/u",
  downloads: "/home/u/Downloads",
  models: "/home/u/.tomat/core/models",
  sessions: "/home/u/.tomat/core/sessions",
  toolkit: "/home/u/.tomat/core/toolkits/x",
};

function grantedFor(decl: PermissionDecl): Grant {
  return {
    toolId: "t",
    permissionKey: permissionKey(decl),
    permissionKind: decl.kind,
    state: "granted",
    grantedAtMs: 0,
  };
}

Deno.test("emptyFlagSet: all sets empty, ffi false", () => {
  const f = emptyFlagSet();
  assertEquals(f.net.size, 0);
  assertEquals(f.read.size, 0);
  assertEquals(f.write.size, 0);
  assertEquals(f.run.size, 0);
  assertEquals(f.env.size, 0);
  assertEquals(f.sys.size, 0);
  assertEquals(f.ffi, false);
});

Deno.test("unionFlags: only granted decls contribute; ungranted are skipped", () => {
  const granted: PermissionDecl = {
    kind: "net",
    host: "api.example.com",
    ports: [443],
    reason: "x",
  };
  const ungranted: PermissionDecl = {
    kind: "read",
    path: "/etc/hosts",
    reason: "x",
  };
  const flags = unionFlags(
    [{ required: [granted, ungranted], grants: [grantedFor(granted)] }],
    templates,
  );
  assertEquals(flags.net.has("api.example.com:443"), true);
  assertEquals(flags.read.size, 0);
});

Deno.test("unionFlags: net expands one entry per (host, port)", () => {
  const decl: PermissionDecl = {
    kind: "net",
    host: "api.example.com",
    ports: [80, 443],
    reason: "x",
  };
  const flags = unionFlags(
    [{ required: [decl], grants: [grantedFor(decl)] }],
    templates,
  );
  assertEquals(flags.net.has("api.example.com:80"), true);
  assertEquals(flags.net.has("api.example.com:443"), true);
});

Deno.test("unionFlags: read/write apply path templates", () => {
  const decl: PermissionDecl = {
    kind: "write",
    path: "$downloads/out",
    reason: "x",
  };
  const flags = unionFlags(
    [{ required: [decl], grants: [grantedFor(decl)] }],
    templates,
  );
  assertEquals(flags.write.has("/home/u/Downloads/out"), true);
});

Deno.test("unionFlags: ffi flips the boolean, sys is a set", () => {
  const ffi: PermissionDecl = { kind: "ffi", reason: "x" };
  const sys: PermissionDecl = { kind: "sys", flag: "hostname", reason: "x" };
  const flags = unionFlags(
    [{ required: [ffi, sys], grants: [grantedFor(ffi), grantedFor(sys)] }],
    templates,
  );
  assertEquals(flags.ffi, true);
  assertEquals(flags.sys.has("hostname"), true);
});

Deno.test("unionFlags: identical grants across tools deduplicate", () => {
  const decl: PermissionDecl = { kind: "env", key: "FOO", reason: "x" };
  const flags = unionFlags(
    [
      { required: [decl], grants: [grantedFor(decl)] },
      { required: [decl], grants: [grantedFor(decl)] },
    ],
    templates,
  );
  assertEquals(flags.env.size, 1);
  assertEquals(flags.env.has("FOO"), true);
});

Deno.test("flagSetToArgs: emits one --allow-* per non-empty bucket", () => {
  const f = emptyFlagSet();
  f.net.add("a:80");
  f.net.add("b:443");
  f.read.add("/r");
  f.ffi = true;
  const args = flagSetToArgs(f);
  assertEquals(args.includes("--allow-net=a:80,b:443"), true);
  assertEquals(args.includes("--allow-read=/r"), true);
  assertEquals(args.includes("--allow-ffi"), true);
});

Deno.test("flagSetToArgs: omits buckets that are empty", () => {
  const args = flagSetToArgs(emptyFlagSet());
  assertEquals(args, []);
});

Deno.test("expandPath: substitutes $home/$downloads/$models/$sessions/$toolkit", () => {
  assertEquals(expandPath("$home/foo", templates), "/home/u/foo");
  assertEquals(expandPath("$downloads", templates), "/home/u/Downloads");
  assertEquals(
    expandPath("$models/x", templates),
    "/home/u/.tomat/core/models/x",
  );
  assertEquals(
    expandPath("$toolkit", templates),
    "/home/u/.tomat/core/toolkits/x",
  );
});

Deno.test("expandPath: substitutes $env.VAR from process env", () => {
  Deno.env.set("TOMAT_PERMISSIONS_T0_VAR", "value");
  try {
    assertEquals(
      expandPath("$env.TOMAT_PERMISSIONS_T0_VAR/x", templates),
      "value/x",
    );
  } finally {
    Deno.env.delete("TOMAT_PERMISSIONS_T0_VAR");
  }
});
