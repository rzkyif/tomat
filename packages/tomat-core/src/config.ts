// Bootstrap config + URLs.
// All hardcoded URLs live here so changing the hostnames later is a one-file
// edit.

import { channel, corePort } from "./paths.ts";

export const CORE_VERSION = "0.1.0";

// Two-host layout:
//
//   WEBSITE_BASE_URL  is the landing page (Cloudflare Worker / Astro static
//                       assets). Nothing release-related lives here; the core
//                       runtime does not consume this URL.
//   STORAGE_BASE_URL  is the public R2 bucket holding every release artifact:
//                       /<version>/<triple>/<file>, /manifests/*.json,
//                       /install/*, /schemas/*.
export const WEBSITE_BASE_URL = "https://au.tomat.ing";
export const STORAGE_BASE_URL = "https://get.au.tomat.ing";

// Manifests live under a per-channel path segment so beta/dev publish + fetch
// their own signed manifests without touching stable's. Stable stays bare
// (manifests/core.json) for back-compat; dev/beta nest (manifests/beta/...).
function manifestDir(): string {
  const ch = channel();
  return ch === "stable" ? "manifests" : `manifests/${ch}`;
}

export function coreManifestUrl(): string {
  return `${STORAGE_BASE_URL}/${manifestDir()}/core.json`;
}

export function binaryManifestUrl(): string {
  return `${STORAGE_BASE_URL}/${manifestDir()}/binaries.json`;
}

// Signed manifest for the CDN-distributed built-in toolkit, nested per channel
// alongside core.json / binaries.json.
export function builtinToolkitManifestUrl(): string {
  return `${STORAGE_BASE_URL}/${manifestDir()}/toolkit.json`;
}

// Schemas (tools-v1.json) are channel-independent: one published copy.
export const SCHEMAS_BASE_URL = `${STORAGE_BASE_URL}/schemas`;

// Default HTTP bind. Override via TOMAT_CORE_HOST / TOMAT_CORE_PORT env.
// DEFAULT_PORT is the stable base; loadBootConfig() applies the per-channel
// offset via corePort() so beta/dev cores bind a distinct port by default.
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7800;

export interface BootConfig {
  host: string;
  port: number;
  version: string;
}

export function loadBootConfig(): BootConfig {
  const portStr = Deno.env.get("TOMAT_CORE_PORT");
  const port = portStr ? Number(portStr) : corePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid TOMAT_CORE_PORT: ${portStr}`);
  }
  const host = Deno.env.get("TOMAT_CORE_HOST") ?? DEFAULT_HOST;
  return { host, port, version: CORE_VERSION };
}
