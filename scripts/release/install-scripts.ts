// Release item: install scripts (scripts/install/*.{sh,ps1}) uploaded to R2
// under install/. Channel-independent (one shared copy serves every channel).
// apply() still byte-compares each file against R2 so an unchanged file in a
// changed set isn't re-uploaded.

import { join } from "@std/path";
import {
  type ApplyOpts,
  bumpVersionField,
  bytesEqual,
  type DeployEnv,
  fetchR2Bytes,
  hashPaths,
  info,
  INSTALL_DIR,
  ok,
  mapPool,
  R2_CONCURRENCY,
  r2Put,
  readVersionField,
  type ReleaseChannel,
  type ReleaseItem,
  step,
} from "./lib.ts";

const INSTALL_SCRIPTS: Array<{ name: string; contentType: string }> = [
  { name: "core.sh", contentType: "text/x-shellscript" },
  { name: "core-uninstall.sh", contentType: "text/x-shellscript" },
  { name: "client.sh", contentType: "text/x-shellscript" },
  { name: "client-uninstall.sh", contentType: "text/x-shellscript" },
  { name: "core.ps1", contentType: "application/x-powershell" },
  { name: "core-uninstall.ps1", contentType: "application/x-powershell" },
  { name: "client.ps1", contentType: "application/x-powershell" },
  { name: "client-uninstall.ps1", contentType: "application/x-powershell" },
];

const SCRIPT_CACHE_CONTROL = "public, max-age=300";

export const scriptsItem: ReleaseItem = {
  id: "scripts",
  label: "install scripts",
  scope: "shared",
  packages: [],
  bumpHint: "scripts/install/version.json (version)",

  // version.json is intentionally NOT in INSTALL_SCRIPTS, so it's neither hashed
  // nor uploaded: it's the bump source only. A lone bump won't trip the diff;
  // bump it alongside the actual script change it accompanies.
  version: () => readVersionField(join(INSTALL_DIR, "version.json")),
  versionFile: join(INSTALL_DIR, "version.json"),
  bumpVersion: () => bumpVersionField(join(INSTALL_DIR, "version.json")),

  sourceHash(_channel: ReleaseChannel): Promise<string> {
    return hashPaths(INSTALL_SCRIPTS.map((s) => ({ path: join(INSTALL_DIR, s.name) })));
  },

  // Install scripts ship as-is (no compile step); the work is compare + upload.
  async apply(env: DeployEnv, _channel: ReleaseChannel, opts: ApplyOpts): Promise<void> {
    step(`Syncing ${INSTALL_SCRIPTS.length} install scripts to R2`);
    const results = await mapPool(
      INSTALL_SCRIPTS,
      R2_CONCURRENCY,
      async ({ name, contentType }) => {
        const src = join(INSTALL_DIR, name);
        const r2Key = `install/${name}`;
        const local = await Deno.readFile(src);
        const remote = await fetchR2Bytes(env, r2Key);
        if (remote && bytesEqual(local, remote)) {
          info(`unchanged: ${r2Key}`);
          return false;
        }
        if (opts.dryRun) {
          info(`would upload ${r2Key}`);
          return false;
        }
        await r2Put(env, r2Key, src, contentType, SCRIPT_CACHE_CONTROL);
        ok(`uploaded ${r2Key}`);
        return true;
      },
    );
    const uploaded = results.filter(Boolean).length;
    if (!opts.dryRun) {
      ok(`uploaded ${uploaded}/${INSTALL_SCRIPTS.length} install scripts`);
    }
  },
};
