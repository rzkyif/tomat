/**
 * State machine + flows for the add-a-core wizard (NewCore.svelte): the four
 * steps (destination chooser -> local-confirm | remote-address -> remote-pair),
 * the per-step form fields, LAN discovery, connection probing, and the local /
 * remote pairing that ends by registering + selecting the new core.
 *
 * Per the composable convention (see use-autocomplete), this holds the `$state`
 * and imperative flow methods plus pure getters over that state; the component
 * keeps the `$effect`s (the Android back interceptor, the URL stale-check) and
 * the template, and calls `init()` from onMount. `onMobile` is the only piece
 * that comes from the UI context, so it is injected.
 */

import { errMessage, MIN_ADMIN_PASSWORD_LENGTH } from "@tomat/shared";
import {
  cores,
  mintCodeWithAdminToken,
  pairWithCode,
  type PairedCoreEntry,
  probeCore,
  setAdminPasswordWithToken,
} from "$lib/core";
import { type DiscoveredCore, type InstallProgress, platform } from "$lib/platform";
import { getLogger } from "$lib/util/log";
import { isTauri } from "$lib/util/env";
import { modelRecommendState, viewState } from "$stores";

const log = getLogger("cores");
const CLIENT_NAME = "tomat Client";

// Wizard steps. Onboarding (locked) and "no local core paired yet" start at
// `chooseDestination` (default "this computer"); from there the user lands on
// the local-install confirmation page or the remote-address form. Adding an
// additional core while a local core is already paired skips the chooser and
// starts at `remoteAddress`.
export type WizardView = "chooseDestination" | "localConfirm" | "remoteAddress" | "remotePair";

type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "ok"; version: string; checkedUrl: string; behindProxy: boolean }
  | { kind: "error"; message: string };

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Remote Core";
  }
}

const isLoopback = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

export class NewCoreWizard {
  // Resolved from the platform on mount so a latest client targets the latest
  // core's port (7810) rather than the stable 7800. Falls back to the stable
  // default until resolved (and on the web stub).
  localBaseUrl = $state("https://127.0.0.1:7800");

  busy = $state<null | "installing" | "claiming" | "checking">(null);
  // Live phase of the running local install (label + done/total), streamed
  // from the installer transcript by the Rust trampoline. Non-null only while
  // busy === "installing" on the script path; the button renders it as
  // "<label> (<pct>%)" instead of the bare "Installing…".
  installProgress = $state<InstallProgress | null>(null);
  error = $state("");
  remoteUrl = $state("");
  remoteName = $state("");
  remoteCode = $state("");
  connectionStatus = $state<ConnectionStatus>({ kind: "idle" });

  // LAN "ping" discovery: the address-field search button sweeps the local
  // network for reachable cores and lists them below the field. `discovered`
  // holds the last sweep's results; `didSweep` gates the (animated) results
  // panel so a finished sweep with no hits still shows the empty state.
  discovering = $state(false);
  didSweep = $state(false);
  discovered = $state<DiscoveredCore[]>([]);

  view = $state<WizardView>("chooseDestination");
  destination = $state<"local" | "remote">("local");
  installServiceChoice = $state(false);
  installNetworkChoice = $state(false);
  // Whether the new Core will be reached through a terminating HTTPS proxy. When
  // on, the Core is switched into behind-proxy mode AFTER this Client pairs over
  // loopback (a proxy-served Core folds no cert pin, so it can't be paired over
  // loopback); see pairLocal's post-pair flip.
  installBehindProxyChoice = $state(false);
  // Admin password set at install. Required (entered twice) so the user can
  // later pair new devices remotely without reading the admin token off disk.
  installPassword = $state("");
  installPasswordConfirm = $state("");
  localAlreadyInstalled = $state(false);
  // True once the user sent the always-on-top setup window to the background
  // during a local install (see continueInBackground). pairLocal reads it in
  // its finally to bring the window back once the install resolves, so the
  // result (the unlocked UI, or an error) is never stranded off screen.
  private hidWindowForInstall = false;
  // True when the chooser was skipped (a local core is already paired), so the
  // back arrow on the first step cancels the flow instead of revealing a chooser
  // the user was never meant to see.
  chooserSkipped = $state(false);

  constructor(private readonly onMobile: boolean) {}

  get installPasswordValid(): boolean {
    return (
      this.installPassword.length >= MIN_ADMIN_PASSWORD_LENGTH &&
      this.installPassword === this.installPasswordConfirm
    );
  }

  // Whether an intra-wizard step-back is available (same condition as the header
  // back arrow). Drives both the arrow and the Android back interceptor.
  get canStepBack(): boolean {
    return (
      this.view === "remotePair" ||
      ((this.view === "remoteAddress" || this.view === "localConfirm") && !this.chooserSkipped)
    );
  }

  // Suggested name shown as the placeholder on the (optional) name field: the
  // host portion of the address we just connected to.
  get defaultRemoteName(): string {
    return hostFromUrl(this.normalizedRemoteUrl());
  }

  // Called from the consumer's onMount: pick the first step and resolve the
  // local core base URL.
  init(): void {
    void this.decideInitialView();
    void platform()
      .pairing.localCoreBaseUrl()
      .then((url) => {
        this.localBaseUrl = url;
      })
      .catch((e) => log.warn("localCoreBaseUrl failed", e));
  }

  // Pick the first step. Adding an additional core when a local core is already
  // paired skips straight to the remote-address form; everyone else starts at
  // the destination chooser.
  async decideInitialView(): Promise<void> {
    const list = await cores().list();
    const firstEver = list.length === 0;
    const localCorePaired = list.some((c) => isLoopback(c.baseUrl));

    if (this.onMobile) {
      // Remote-only: there is no "this computer" option on mobile, so the
      // chooser and local-install branch are skipped and we go straight to the
      // remote-address form (back-arrow suppressed via chooserSkipped).
      this.destination = "remote";
      this.chooserSkipped = true;
      this.view = "remoteAddress";
    } else if (!firstEver && localCorePaired) {
      this.destination = "remote";
      this.chooserSkipped = true;
      this.view = "remoteAddress";
    } else {
      this.view = "chooseDestination";
    }

    // Prefill the remote fields from launch arguments (--core-url /
    // --pairing-code), as supplied by a shareable setup command or by what
    // `deno task dev` passes. The chooser still defaults to "this computer";
    // the fields are simply ready if the user picks the remote flow. Only
    // fills empty fields, never clobbers typed input.
    try {
      const pre = await platform().pairing.launchPrefill();
      if (pre?.coreUrl) {
        if (!this.remoteUrl.trim()) this.remoteUrl = pre.coreUrl;
        if (!this.remoteCode.trim() && pre.pairingCode) {
          this.remoteCode = pre.pairingCode;
        }
      }
    } catch {
      /* no launch prefill available */
    }

    if (isTauri() && !this.onMobile) {
      try {
        this.localAlreadyInstalled = await platform().pairing.isLocalCoreInstalled();
      } catch {
        this.localAlreadyInstalled = false;
      }
    }
  }

  // The streamed installer's phase count, read in a fresh scope because inline
  // reads of `installProgress` after the install await are narrowed to the
  // pre-await null (TS cannot see the subscription callback's writes).
  private streamedInstallTotal(): number {
    return this.installProgress?.total ?? 1;
  }

  // A local pair can fail because the core died on boot (e.g. its port is
  // taken), which surfaces here only as a connection timeout. The core leaves a
  // one-line breadcrumb; fold it into the message so the user sees the real
  // cause instead of a bare "could not reach the core".
  private async localPairErrorMessage(e: unknown): Promise<string> {
    const base = errMessage(e);
    try {
      const boot = await platform().pairing.readLocalCoreBootError();
      if (boot) return `${base}\n\nThe local Core failed to start: ${boot}`;
    } catch {
      /* best-effort: the breadcrumb is a nicety, not required */
    }
    return base;
  }

  // Claim a pairing code, register the core, select it, and route onward.
  private async claimAndAdd(
    baseUrl: string,
    code: string,
    name: string,
    isLocal = false,
    // Whether the Core is served over HTTPS behind a terminating proxy (from the
    // health probe). A local/loopback core is always self-signed, so false.
    behindProxy = false,
  ): Promise<void> {
    const firstEver = (await cores().list()).length === 0;
    const res = await pairWithCode(baseUrl, CLIENT_NAME, code, behindProxy);
    const entry: PairedCoreEntry = {
      id: res.clientId,
      name,
      baseUrl,
      trustMode: res.trustMode,
      tlsPin: res.tlsPin,
      addedAtMs: Date.now(),
    };
    await cores().addPaired(entry, res.token);
    // select() notifies the registry, which makes settingsState load the new
    // core's settings baseline (and live-sync from there); nothing to fetch
    // here. Edits made before the baseline lands are queued, not dropped.
    await cores().select(entry.id);
    // First-ever local core: apply the hardware-fit Smallest preset now, before
    // the pending-downloads gate surfaces, so a fresh install lands on the model
    // that best fits this device (and the stored preset is truthful) instead of
    // the static baseline default. Best-effort and awaited so the requirements
    // recompute reflects the chosen model: applyBucket swallows its own errors,
    // so if the catalog/hardware probe isn't ready the realigned static default
    // holds and the user can still pick a preset in Settings.
    if (isLocal && firstEver) {
      // Best-effort and time-bounded: applying the hardware-fit preset needs the
      // signed model catalog, which on a brand-new core may require a network
      // fetch (no cache yet). Never let a slow/unreachable fetch hang onboarding
      // on the spinner: the realigned static default is already an accepted 2B
      // baseline, so fall through after a short wait. applyBucket swallows its
      // own errors and, if it lands later, still applies in the background.
      await Promise.race([
        modelRecommendState.applyBucket("smallest"),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    }
    this.busy = null;
    if (firstEver) {
      // First core ever paired: unlock the UI and open the new-user quick
      // settings.
      viewState.setLocked(false);
      viewState.navigate("quickSettings");
    } else {
      // Adding an additional core: return to the Cores manager in Settings.
      viewState.pendingSettingsGroup = "cores";
      viewState.navigate("settings");
    }
  }

  // Step-back within the wizard, one step at a time: remote pairing -> remote
  // address -> destination chooser; local-confirm -> chooser. Only wired to the
  // back arrow, which is hidden when no previous step exists (the chooser, or a
  // skipped-chooser remote root), so it never needs to handle the root case.
  goBack(): void {
    if (this.busy !== null) return;
    this.error = "";
    if (this.view === "remotePair") {
      this.view = "remoteAddress";
      return;
    }
    this.view = "chooseDestination";
  }

  // Explicit exit out of the whole wizard, bound to the close button shown on
  // every step while not locked. Returns to the Cores manager it was launched
  // from. Never reachable while locked (onboarding has nowhere to go).
  exitFlow(): void {
    viewState.pendingSettingsGroup = "cores";
    viewState.navigate("settings");
  }

  // From the destination chooser: route to the right next step. If the user
  // picked "this computer" and the core is already installed, skip the
  // confirmation page entirely and go straight to "fast-path" pairing
  // (which uses the local admin token to mint a code without re-running the
  // installer).
  async continueFromChoose(): Promise<void> {
    this.error = "";
    if (this.destination === "remote") {
      this.connectionStatus = { kind: "idle" };
      this.view = "remoteAddress";
      return;
    }
    if (!isTauri()) {
      this.error = "Local install requires the desktop app";
      return;
    }
    if (this.localAlreadyInstalled) {
      await this.pairLocalAlreadyInstalled();
      return;
    }
    this.installServiceChoice = false;
    this.installNetworkChoice = false;
    this.installBehindProxyChoice = false;
    this.view = "localConfirm";
  }

  // Local core already exists on disk: make sure it's running, mint a
  // pairing code via its admin token, and claim. Skips the install script.
  private async pairLocalAlreadyInstalled(): Promise<void> {
    this.busy = "installing";
    try {
      await platform().pairing.startLocalCore();
      const adminToken = await platform().pairing.readAdminToken();
      if (!adminToken) {
        throw new Error(
          "Local Core admin token not found. The install may be corrupt. " +
            "Delete ~/.tomat/core/ and try again.",
        );
      }
      const { code } = await mintCodeWithAdminToken(this.localBaseUrl, adminToken);
      if (!code) throw new Error("response missing pairing code");
      this.busy = "claiming";
      await this.claimAndAdd(this.localBaseUrl, code, "Local Core", true);
    } catch (e) {
      this.error = await this.localPairErrorMessage(e);
      this.busy = null;
    }
  }

  // Send the always-on-top, immovable setup window to the background during the
  // (potentially slow) local install so the user isn't trapped behind it. The
  // tray icon and global shortcut re-show it on demand; pairLocal also re-shows
  // it automatically once the install resolves. Only meaningful mid-install.
  async continueInBackground(): Promise<void> {
    if (this.busy !== "installing") return;
    this.hidWindowForInstall = true;
    try {
      await platform().windowing.requestHide();
    } catch (e) {
      log.warn("hide for background install failed", e);
      this.hidWindowForInstall = false;
    }
  }

  async pairLocal(): Promise<void> {
    this.error = "";
    this.busy = "installing";
    this.installProgress = null;
    // Follow the installer's phases so the button can narrate them. Best-effort:
    // a failed subscription just leaves the bare "Installing…" label.
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await platform()
        .pairing.subscribeInstallProgress((p) => {
          this.installProgress = p;
        })
        .catch((e) => {
          log.warn("install progress subscription failed", e);
          return null;
        });
      const code = await platform().pairing.installLocalCore({
        service: this.installServiceChoice,
        bindAll: this.installNetworkChoice,
      });
      // The script is done; the remaining pre-pair work (admin password over
      // loopback) is one quick step, shown as the final phase at 100%.
      const total = this.streamedInstallTotal();
      this.installProgress = { label: "Securing your Core", done: total, total };
      // Set the admin password the user chose. The install script never
      // prompts for one (it must run non-interactively), so we set it here
      // over loopback using the freshly-written admin token. The install
      // just minted that token, so a missing one means a corrupt install: fail
      // loudly rather than pair a Core with no admin password (which would
      // silently discard the password the user was required to enter and leave
      // them unable to pair further devices). Mirrors pairLocalAlreadyInstalled.
      const adminToken = await platform().pairing.readAdminToken();
      if (!adminToken) {
        throw new Error(
          "Local Core admin token not found after install. The install may be " +
            "corrupt. Delete ~/.tomat/core/ and try again.",
        );
      }
      await setAdminPasswordWithToken(this.localBaseUrl, adminToken, this.installPassword);
      this.busy = "claiming";
      await this.claimAndAdd(this.localBaseUrl, code, "Local Core", true);
      // "Install, pair, then flip": the pair above ran in pin mode over loopback
      // (a proxy-served Core folds no cert pin, so loopback pairing must happen
      // while the Core still pins). Only now switch the Core into behind-proxy
      // mode and restart it, so later remote devices pair through the proxy. Our
      // loopback pin survives the restart (same key, same cert on loopback).
      // Best-effort: the Core is already paired and working, so a failed flip is
      // logged, not surfaced (claimAndAdd has navigated away); the user can turn
      // on server.behindProxy by hand (see the manual) if the flip did not land.
      if (this.installBehindProxyChoice) {
        try {
          await platform().pairing.enableCoreBehindProxy(this.installServiceChoice);
        } catch (e) {
          log.warn("enable behind-proxy after pairing failed", e);
        }
      }
    } catch (e) {
      this.error = await this.localPairErrorMessage(e);
      this.busy = null;
    } finally {
      unsubscribe?.();
      this.installProgress = null;
      // If the user backgrounded the window mid-install, bring it back now that
      // the install has resolved (success unlocks the UI; failure shows the
      // error). show() is idempotent, so this is a no-op if the tray already
      // re-showed it. Best-effort: a failed re-show must not mask the result.
      if (this.hidWindowForInstall) {
        this.hidWindowForInstall = false;
        try {
          await platform().windowing.show();
        } catch (e) {
          log.warn("re-show after background install failed", e);
        }
      }
    }
  }

  normalizedRemoteUrl(): string {
    let u = this.remoteUrl.trim().replace(/\/+$/, "");
    if (!u) return "";
    // TLS-only: coerce http:// -> https://, and default to https:// when the
    // user typed a bare host:port. The core never serves plaintext.
    if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, "https://");
    else if (!/^https:\/\//i.test(u)) u = `https://${u}`;
    return u;
  }

  async checkConnection(): Promise<void> {
    this.error = "";
    const url = this.normalizedRemoteUrl();
    if (!url) {
      this.connectionStatus = { kind: "error", message: "Enter the Core's address." };
      return;
    }
    this.busy = "checking";
    try {
      const { version, behindProxy } = await probeCore(url);
      this.connectionStatus = { kind: "ok", version, checkedUrl: url, behindProxy };
      // Connection confirmed: advance to the naming + pairing-code stage.
      this.view = "remotePair";
    } catch (e) {
      const message = errMessage(e);
      this.connectionStatus = {
        kind: "error",
        message: `Could not reach Core: ${message}`,
      };
    } finally {
      this.busy = null;
    }
  }

  // Sweep the local network for reachable cores (the address-field "ping"
  // button). Discovery only reads each core's public /api/v1/health; the
  // address it fills still has to clear the full PAKE pairing below, so nothing
  // found here is trusted yet.
  async pingNetwork(): Promise<void> {
    if (this.discovering) return;
    this.error = "";
    this.discovering = true;
    try {
      this.discovered = await platform().net.discoverCores();
    } catch (e) {
      log.warn("core discovery failed", e);
      this.discovered = [];
    } finally {
      this.didSweep = true;
      this.discovering = false;
    }
  }

  // Fill the address field from a discovered core and collapse the list. The
  // user still enters the pairing code on the next step.
  useDiscovered(core: DiscoveredCore): void {
    this.remoteUrl = core.baseUrl;
    this.discovered = [];
    this.didSweep = false;
  }

  async pairRemote(): Promise<void> {
    this.error = "";
    const url = this.normalizedRemoteUrl();
    if (!url) {
      this.error = "Enter the Core's address";
      return;
    }
    if (!/^\d{6}$/.test(this.remoteCode)) {
      this.error = "Pairing code must be 6 digits";
      return;
    }
    if (this.connectionStatus.kind !== "ok" || this.connectionStatus.checkedUrl !== url) {
      this.error = "Check the connection first";
      return;
    }
    const { behindProxy } = this.connectionStatus;
    this.busy = "claiming";
    try {
      await this.claimAndAdd(
        url,
        this.remoteCode,
        this.remoteName.trim() || hostFromUrl(url),
        false,
        behindProxy,
      );
      this.remoteUrl = "";
      this.remoteName = "";
      this.remoteCode = "";
      this.connectionStatus = { kind: "idle" };
    } catch (e) {
      this.error = errMessage(e);
      this.busy = null;
    }
  }
}
