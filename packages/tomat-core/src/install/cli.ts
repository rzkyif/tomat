// Argv dispatcher for the install/uninstall subcommands.
//
// main.ts calls this before booting the server: when argv[0] is one of the
// known verbs the core binary acts as a short-lived installer CLI and exits;
// otherwise (empty argv from launchd/systemd, or the updater's --restart-args)
// it returns null and the server boots. This is what lets every installer
// front-end - the native packages' post-install hooks, the client's in-app
// "set up a local Core" flow, and the thin bootstrap scripts - wrap ONE
// implementation of service registration, secret bootstrap, and pairing.
//
// Verbs:
//   self-install       fetch + verify + place the binary set from core.json
//   bootstrap          admin token, optional bind-all seed, plant built-in ext
//   install-service    bootstrap, then register + start the OS service
//   mint-code          print one JSON line: { code, url, port }
//   uninstall-service  stop + remove the service, keychain key, and data
//
// Env honored: TOMAT_CHANNEL (channel selection, via paths.ts),
// TOMAT_INSTALL_SERVICE (0 = background, no service), TOMAT_INSTALL_BIND_ALL
// (1 = seed server.bindHost=0.0.0.0). Flags: --keep-data (uninstall),
// --bind-all (bootstrap/install-service, same as TOMAT_INSTALL_BIND_ALL=1).

import { errMessage } from "@tomat/shared";
import { bootstrap } from "./bootstrap.ts";
import { installService, uninstallService } from "./service.ts";
import { mintCode } from "./pair.ts";
import { selfInstall } from "./fetch-verify.ts";
import { progress } from "./io.ts";

const VERBS = new Set([
  "self-install",
  "bootstrap",
  "install-service",
  "mint-code",
  "uninstall-service",
]);

/** Run an install subcommand if argv names one. Returns the process exit code
 *  to use, or null when argv is not a subcommand (server should boot). Never
 *  throws: a failing subcommand returns exit code 1. */
export async function maybeRunInstallCommand(args: string[]): Promise<number | null> {
  const verb = args[0];
  if (!verb || !VERBS.has(verb)) return null;

  const flags = new Set(args.slice(1).filter((a) => a.startsWith("--")));
  const bindAll = flags.has("--bind-all") || Deno.env.get("TOMAT_INSTALL_BIND_ALL") === "1";
  const keepData = flags.has("--keep-data");

  try {
    switch (verb) {
      case "self-install":
        await selfInstall();
        break;
      case "bootstrap":
        await bootstrap({ bindAll });
        break;
      case "install-service":
        // Bootstrap (idempotent) then register the service, so a single call
        // from an installer post-install hook fully provisions the daemon.
        await bootstrap({ bindAll });
        await installService();
        break;
      case "mint-code":
        await mintCode();
        break;
      case "uninstall-service":
        await uninstallService({ keepData });
        break;
    }
    return 0;
  } catch (err) {
    progress(`${verb} failed: ${errMessage(err)}`);
    return 1;
  }
}
