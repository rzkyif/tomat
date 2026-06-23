// Shared types and tiny helpers for the extension installer's phases
// (installer-download.ts / installer-register.ts / installer-deps.ts). This is
// the dependency leaf: every phase module imports from here, so nothing here may
// import them back.

export type InstallSource =
  | { source: "npm"; name: string; version?: string }
  | { source: "local"; path: string; slug: string }
  // The CDN-distributed built-in extension. Bytes are resolved at install time:
  // the codebase (dev), `preferLocalDir` if it exists (install-script-placed
  // files, used by first-boot seeding), else the signed CDN tarball.
  | { source: "builtin"; preferLocalDir?: string };

export interface InstallEventSink {
  log(jobId: string, id: string, stream: "stdout" | "stderr", line: string): void;
  done(jobId: string, id: string, ok: boolean, code: number): void;
}

export function flattenNpmName(name: string): string {
  // @scope/name -> @scope__name to land cleanly under extensions/<id>/.
  return name.replace("/", "__");
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}
