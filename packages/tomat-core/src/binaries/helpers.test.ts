import { assertThrows } from "@std/assert";
import { ensureHelperBinaries } from "./helpers.ts";
import { coreBinaryName } from "./versions.ts";
import { binPath, paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";

// The helper names ensureHelperBinaries requires on this platform (ptyhost is
// unix-only). Kept in sync with requiredHelpers() in helpers.ts.
const REQUIRED = ["tomat-core-keychain", "tomat-core-updater", "tomat-core-hwinfo"].concat(
  Deno.build.os === "windows" ? [] : ["tomat-core-ptyhost"],
);

// paths.ts reads HOME / TOMAT_CORE_HOME / TOMAT_CHANNEL at call time. Point all
// of them at a fresh tempdir so binPath() resolves inside it, and restore after
// (the suite runs single-threaded).
function withTempBin(fn: (binDir: string) => void): void {
  const keys = ["HOME", "USERPROFILE", "TOMAT_CORE_HOME", "TOMAT_CHANNEL"];
  const prior: Record<string, string | undefined> = {};
  for (const k of keys) prior[k] = Deno.env.get(k);
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.env.set("HOME", tmp);
    Deno.env.set("USERPROFILE", tmp);
    Deno.env.set("TOMAT_CORE_HOME", tmp);
    Deno.env.set("TOMAT_CHANNEL", "stable");
    Deno.mkdirSync(paths().binDir, { recursive: true });
    fn(paths().binDir);
  } finally {
    for (const k of keys) {
      const v = prior[k];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    Deno.removeSync(tmp, { recursive: true });
  }
}

Deno.test("ensureHelperBinaries throws when helper binaries are missing", () => {
  withTempBin(() => {
    assertThrows(() => ensureHelperBinaries(), AppError, "missing helper binaries");
  });
});

Deno.test("ensureHelperBinaries throws naming the specific missing helper", () => {
  withTempBin(() => {
    // All present except hwinfo.
    for (const name of REQUIRED) {
      if (name === "tomat-core-hwinfo") continue;
      Deno.writeTextFileSync(binPath(coreBinaryName(name)), "");
    }
    assertThrows(() => ensureHelperBinaries(), AppError, "tomat-core-hwinfo");
  });
});

Deno.test("ensureHelperBinaries passes when every required helper is present", () => {
  withTempBin(() => {
    for (const name of REQUIRED) Deno.writeTextFileSync(binPath(coreBinaryName(name)), "");
    ensureHelperBinaries(); // must not throw
  });
});
