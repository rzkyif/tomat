// Release item: published JSON schemas (currently just tomat-v1.json) uploaded
// to R2 under schemas/. Channel-independent. apply() byte-compares each file
// against R2 so an unchanged schema isn't re-uploaded.

import { join } from "@std/path";
import {
  type ApplyOpts,
  bytesEqual,
  type DeployEnv,
  fetchR2Bytes,
  hashPaths,
  info,
  ok,
  r2Put,
  readVersionField,
  type ReleaseChannel,
  type ReleaseItem,
  REPO_ROOT,
  step,
} from "./lib.ts";

const SCHEMAS: Array<{ src: string; r2Key: string }> = [
  {
    src: "packages/tomat-shared/src/tomat-json-schema.json",
    r2Key: "schemas/tomat-v1.json",
  },
];

// The published schema's own `version` field is the release version for this
// item (it travels with the artifact). Bump it there to ship a new schema.
const VERSION_SRC = "packages/tomat-shared/src/tomat-json-schema.json";

const SCHEMA_CACHE_CONTROL = "public, max-age=3600";

export const schemasItem: ReleaseItem = {
  id: "schemas",
  label: "JSON schemas",
  scope: "shared",
  packages: ["shared"],
  bumpHint: `${VERSION_SRC} (version)`,

  version: () => readVersionField(join(REPO_ROOT, VERSION_SRC)),

  sourceHash(_channel: ReleaseChannel): Promise<string> {
    return hashPaths(SCHEMAS.map((s) => ({ path: join(REPO_ROOT, s.src) })));
  },

  // Schemas ship as-is (no compile step); the work is the byte-compare + upload.
  async apply(env: DeployEnv, _channel: ReleaseChannel, opts: ApplyOpts): Promise<void> {
    step(`Syncing ${SCHEMAS.length} JSON schemas to R2`);
    let uploaded = 0;
    for (const { src, r2Key } of SCHEMAS) {
      const fullSrc = join(REPO_ROOT, src);
      const local = await Deno.readFile(fullSrc);
      const remote = await fetchR2Bytes(env, r2Key);
      if (remote && bytesEqual(local, remote)) {
        info(`unchanged: ${r2Key}`);
        continue;
      }
      if (opts.dryRun) {
        info(`would upload ${r2Key}`);
        continue;
      }
      await r2Put(env, r2Key, fullSrc, "application/json", SCHEMA_CACHE_CONTROL);
      ok(`uploaded ${r2Key}`);
      uploaded++;
    }
    if (!opts.dryRun) ok(`uploaded ${uploaded}/${SCHEMAS.length} schemas`);
  },
};
