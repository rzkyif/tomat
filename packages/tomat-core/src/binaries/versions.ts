// Host-triple detection + canonical binary names.
//
// The on-disk layout strips the triple from filenames - core only ever has
// one platform's binary installed at a time. The triple appears in download
// URLs (per the manifest) and in cache keys.

import type { BinaryKind, Triple } from "@tomat/shared";

export function hostTriple(): Triple {
  return Deno.build.target as Triple;
}

export function platformExe(): "" | ".exe" {
  return Deno.build.os === "windows" ? ".exe" : "";
}

// Canonical on-disk filename per binary (with .exe on Windows where relevant).
export function binaryName(kind: BinaryKind): string {
  return `${kind}${platformExe()}`;
}
