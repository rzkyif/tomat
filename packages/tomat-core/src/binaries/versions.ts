// Host-triple detection + canonical binary names.
//
// The on-disk layout strips the triple from filenames - core only ever has
// one platform's binary installed at a time. The triple appears in download
// URLs (per the manifest) and in cache keys.

import type { BinaryKind, Triple } from "@tomat/shared";
import { channelBinName } from "../paths.ts";

export function hostTriple(): Triple {
  return Deno.build.target as Triple;
}

export function platformExe(): "" | ".exe" {
  return Deno.build.os === "windows" ? ".exe" : "";
}

// Canonical on-disk filename per sidecar binary (llama-server, whisper-server,
// deno), with .exe on Windows. NOT channel-suffixed: upstream sidecars are
// isolated by the per-channel bin dir and keep their original names.
export function binaryName(kind: BinaryKind): string {
  return `${kind}${platformExe()}`;
}

// On-disk filename for one of tomat's OWN binaries (tomat-core,
// tomat-core-updater, tomat-core-keychain): channel-suffixed (so beta's
// tomat-core-beta coexists with stable's tomat-core) + .exe on Windows.
export function coreBinaryName(base: string): string {
  return `${channelBinName(base)}${platformExe()}`;
}
