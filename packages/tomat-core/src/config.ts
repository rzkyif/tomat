// Bootstrap config + CDN URLs.
// All hardcoded URLs live here so changing the CDN later is a one-file edit.

export const CORE_VERSION = "0.1.0";

// Two-host CDN layout (set up because R2 custom domains hijack an entire
// hostname; serving large binaries via Worker would cost per-request).
//
//   CDN_BASE_URL       — small static-ish files behind the Astro Worker:
//                        /, /manifests/*, /install/*, /schemas/*.
//   RELEASES_BASE_URL  — public R2 bucket holding compiled binaries at
//                        /<version>/<triple>/<file>. Manifest URLs point here.
export const CDN_BASE_URL = "https://au.tomat.ing";
export const RELEASES_BASE_URL = "https://get.au.tomat.ing";

export const BINARY_MANIFEST_URL = `${CDN_BASE_URL}/manifests/binaries.json`;
export const CORE_MANIFEST_URL = `${CDN_BASE_URL}/manifests/core.json`;
export const SCHEMAS_BASE_URL = `${CDN_BASE_URL}/schemas`;

// Default HTTP bind. Override via TOMAT_CORE_HOST / TOMAT_CORE_PORT env.
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7800;

export interface BootConfig {
  host: string;
  port: number;
  version: string;
}

export function loadBootConfig(): BootConfig {
  const portStr = Deno.env.get("TOMAT_CORE_PORT");
  const port = portStr ? Number(portStr) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid TOMAT_CORE_PORT: ${portStr}`);
  }
  const host = Deno.env.get("TOMAT_CORE_HOST") ?? DEFAULT_HOST;
  return { host, port, version: CORE_VERSION };
}
