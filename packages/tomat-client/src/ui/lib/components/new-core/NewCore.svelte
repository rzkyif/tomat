<script lang="ts">
  // Add-a-core wizard. It is the only reachable mode while no core is paired
  // (viewState.locked: first launch, or after the last core is removed), and is
  // also launched from the Cores settings manager to add an additional core.
  // When adding an additional core and a local core is already paired, the
  // local/remote chooser is skipped (a second local install is unsupported).

  import { onMount } from "svelte";
  import { errMessage } from "@tomat/shared";
  import Bubble from "../ui/Bubble.svelte";
  import Alert from "../ui/Alert.svelte";
  import Button from "../ui/Button.svelte";
  import FormField from "../ui/FormField.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Input from "../ui/Input.svelte";
  import {
    cores,
    mintCodeWithAdminToken,
    pairWithCode,
    type PairedCoreEntry,
    probeCore,
  } from "$lib/core";
  import { platform } from "$lib/platform";
  import { getLogger } from "$lib/shared/log";
  import { isTauri } from "$lib/shared/env";
  import { settingsState, viewState } from "$lib/state";

  const log = getLogger("cores");
  const CLIENT_NAME = "tomat client";
  // Resolved from the platform on mount so a beta client targets the beta
  // core's port (7810) rather than the stable 7800. Falls back to the stable
  // default until resolved (and on the web stub).
  let localBaseUrl = $state("https://127.0.0.1:7800");

  let alignment = $derived(settingsState.getAlignment());

  let busy = $state<null | "installing" | "claiming" | "checking">(null);
  let error = $state("");
  let remoteUrl = $state("");
  let remoteName = $state("");
  let remoteCode = $state("");
  let connectionStatus = $state<
    | { kind: "idle" }
    | { kind: "ok"; version: string; checkedUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Suggested name shown as the placeholder on the (optional) name field: the
  // host portion of the address we just connected to.
  let defaultRemoteName = $derived(hostFromUrl(normalizedRemoteUrl()));

  // Wizard steps. Onboarding (locked) and "no local core paired yet" start at
  // `chooseDestination` (default "this computer"); from there the user lands on
  // the local-install confirmation page or the remote-address form. Adding an
  // additional core while a local core is already paired skips the chooser and
  // starts at `remoteAddress`.
  type View =
    | "chooseDestination"
    | "localConfirm"
    | "remoteAddress"
    | "remotePair";
  let view = $state<View>("chooseDestination");
  let destination = $state<"local" | "remote">("local");
  let installServiceChoice = $state(true);
  let installNetworkChoice = $state(false);
  let localAlreadyInstalled = $state(false);
  // True when the chooser was skipped (a local core is already paired), so the
  // back arrow on the first step cancels the flow instead of revealing a chooser
  // the user was never meant to see.
  let chooserSkipped = $state(false);

  // Placeholder docs URL. The page does not exist yet (tomat is not live).
  const CORE_SETUP_DOCS_URL = "https://au.tomat.ing/docs/core-setup";

  const isLoopback = (u: string) =>
    u.includes("127.0.0.1") || u.includes("localhost");

  // Pick the first step. Adding an additional core when a local core is already
  // paired skips straight to the remote-address form; everyone else starts at
  // the destination chooser.
  async function decideInitialView(): Promise<void> {
    const list = await cores().list();
    const firstEver = list.length === 0;
    const localCorePaired = list.some((c) => isLoopback(c.baseUrl));

    if (!firstEver && localCorePaired) {
      destination = "remote";
      chooserSkipped = true;
      view = "remoteAddress";
    } else {
      view = "chooseDestination";
    }

    // Prefill the remote fields from launch arguments (--core-url /
    // --pairing-code), as supplied by a shareable setup command or by what
    // `deno task dev` passes. The chooser still defaults to "this computer";
    // the fields are simply ready if the user picks the remote flow. Only
    // fills empty fields, never clobbers typed input.
    try {
      const pre = await platform().pairing.launchPrefill();
      if (pre?.coreUrl) {
        if (!remoteUrl.trim()) remoteUrl = pre.coreUrl;
        if (!remoteCode.trim() && pre.pairingCode) {
          remoteCode = pre.pairingCode;
        }
      }
    } catch {
      /* no launch prefill available */
    }

    if (isTauri()) {
      try {
        localAlreadyInstalled = await platform().pairing.isLocalCoreInstalled();
      } catch {
        localAlreadyInstalled = false;
      }
    }
  }

  onMount(() => {
    void decideInitialView();
    void platform()
      .pairing.localCoreBaseUrl()
      .then((url) => {
        localBaseUrl = url;
      })
      .catch((e) => log.warn("localCoreBaseUrl failed", e));
  });

  function hostFromUrl(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "Remote Core";
    }
  }

  // Claim a pairing code, register the core, select it, and route onward.
  async function claimAndAdd(
    baseUrl: string,
    code: string,
    name: string,
  ): Promise<void> {
    const firstEver = (await cores().list()).length === 0;
    const res = await pairWithCode(baseUrl, CLIENT_NAME, code);
    const entry: PairedCoreEntry = {
      id: res.clientId,
      name,
      baseUrl,
      tlsPin: res.tlsPin,
      addedAtMs: Date.now(),
    };
    await cores().addPaired(entry, res.token);
    // select() notifies the registry, which makes settingsState load the new
    // core's settings baseline (and live-sync from there); nothing to fetch
    // here. Edits made before the baseline lands are queued, not dropped.
    await cores().select(entry.id);
    busy = null;
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

  // Step-back within the wizard, one step at a time: remote pairing → remote
  // address → destination chooser; local-confirm → chooser. Only wired to the
  // back arrow, which is hidden when no previous step exists (the chooser, or a
  // skipped-chooser remote root), so it never needs to handle the root case.
  function goBack(): void {
    if (busy !== null) return;
    error = "";
    if (view === "remotePair") {
      view = "remoteAddress";
      return;
    }
    view = "chooseDestination";
  }

  // Explicit exit out of the whole wizard, bound to the close button shown on
  // every step while not locked. Returns to the Cores manager it was launched
  // from. Never reachable while locked (onboarding has nowhere to go).
  function exitFlow(): void {
    viewState.pendingSettingsGroup = "cores";
    viewState.navigate("settings");
  }

  // From the destination chooser: route to the right next step. If the user
  // picked "this computer" and the core is already installed, skip the
  // confirmation page entirely and go straight to "fast-path" pairing
  // (which uses the local admin token to mint a code without re-running the
  // installer).
  async function continueFromChoose(): Promise<void> {
    error = "";
    if (destination === "remote") {
      connectionStatus = { kind: "idle" };
      view = "remoteAddress";
      return;
    }
    if (!isTauri()) {
      error = "Local install requires the desktop app.";
      return;
    }
    if (localAlreadyInstalled) {
      await pairLocalAlreadyInstalled();
      return;
    }
    installServiceChoice = true;
    installNetworkChoice = false;
    view = "localConfirm";
  }

  // Local core already exists on disk: make sure it's running, mint a
  // pairing code via its admin token, and claim. Skips the install script.
  async function pairLocalAlreadyInstalled(): Promise<void> {
    busy = "installing";
    try {
      await platform().pairing.startLocalCore();
      const adminToken = await platform().pairing.readAdminToken();
      if (!adminToken) {
        throw new Error(
          "Local core admin token not found. The install may be corrupt. " +
            "Delete ~/.tomat/core/ and try again.",
        );
      }
      const { code } = await mintCodeWithAdminToken(localBaseUrl, adminToken);
      if (!code) throw new Error("response missing pairing code");
      busy = "claiming";
      await claimAndAdd(localBaseUrl, code, "Local Core");
    } catch (e) {
      error = errMessage(e);
      busy = null;
    }
  }

  async function pairLocal(): Promise<void> {
    error = "";
    busy = "installing";
    try {
      const code = await platform().pairing.installLocalCore({
        service: installServiceChoice,
        bindAll: installNetworkChoice,
      });
      busy = "claiming";
      await claimAndAdd(localBaseUrl, code, "Local Core");
    } catch (e) {
      error = errMessage(e);
      busy = null;
    }
  }

  function normalizedRemoteUrl(): string {
    let u = remoteUrl.trim().replace(/\/+$/, "");
    if (!u) return "";
    // TLS-only: coerce http:// → https://, and default to https:// when the
    // user typed a bare host:port. The core never serves plaintext.
    if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, "https://");
    else if (!/^https:\/\//i.test(u)) u = `https://${u}`;
    return u;
  }

  // Stale-check the connection state whenever the URL field changes: the
  // ok/version snapshot is only meaningful for the URL we actually probed.
  $effect(() => {
    const _ = remoteUrl;
    if (connectionStatus.kind === "ok" &&
        connectionStatus.checkedUrl !== normalizedRemoteUrl()) {
      connectionStatus = { kind: "idle" };
    }
  });

  async function checkConnection(): Promise<void> {
    error = "";
    const url = normalizedRemoteUrl();
    if (!url) {
      connectionStatus = { kind: "error", message: "Enter the core's address." };
      return;
    }
    busy = "checking";
    try {
      const { version } = await probeCore(url);
      connectionStatus = { kind: "ok", version, checkedUrl: url };
      // Connection confirmed: advance to the naming + pairing-code stage.
      view = "remotePair";
    } catch (e) {
      const message = errMessage(e);
      connectionStatus = {
        kind: "error",
        message: `Could not reach core: ${message}`,
      };
    } finally {
      busy = null;
    }
  }

  async function pairRemote(): Promise<void> {
    error = "";
    const url = normalizedRemoteUrl();
    if (!url) {
      error = "Enter the core's address.";
      return;
    }
    if (!/^\d{6}$/.test(remoteCode)) {
      error = "Pairing code must be 6 digits.";
      return;
    }
    if (connectionStatus.kind !== "ok" || connectionStatus.checkedUrl !== url) {
      error = "Check the connection first.";
      return;
    }
    busy = "claiming";
    try {
      await claimAndAdd(url, remoteCode, remoteName.trim() || hostFromUrl(url));
      remoteUrl = "";
      remoteName = "";
      remoteCode = "";
      connectionStatus = { kind: "idle" };
    } catch (e) {
      error = errMessage(e);
      busy = null;
    }
  }
</script>

<Bubble
  selectedAlignment={alignment}
  extraClass="flex flex-col gap-4 w-[22.5rem] max-w-full"
>
  {#if view === "chooseDestination" && viewState.locked}
    <!-- Onboarding welcome: centered logo + title, no exit (locked in until a
         core is paired). -->
    <div class="flex flex-col items-center gap-3 pt-2">
      <span
        class="w-14 h-14 bg-default-800 shrink-0"
        style="mask:url(/tomat.svg) center/contain no-repeat;-webkit-mask:url(/tomat.svg) center/contain no-repeat;"
        aria-hidden="true"
      ></span>
      <h1 class="text-lg font-medium text-default-800">Welcome to tomat</h1>
    </div>
  {:else}
    <!-- Header: an optional left back arrow (intra-wizard step-back, hidden when
         no previous step exists), a centered title, and an optional right close
         (explicit exit, shown whenever a core is already connected). A spacer
         balances whichever side control is absent so the title stays centered. -->
    {@const showBack =
      view === "remotePair" ||
      ((view === "remoteAddress" || view === "localConfirm") && !chooserSkipped)}
    <div class="flex items-center gap-2">
      {#if showBack}
        <IconButton
          icon="i-material-symbols-arrow-back-rounded"
          title="Back"
          size="lg"
          variant="subtle"
          surface="circle"
          disabled={busy !== null}
          onclick={goBack}
        />
      {:else}
        <div class="w-9 shrink-0" aria-hidden="true"></div>
      {/if}
      <h1 class="text-lg font-medium text-default-800 flex-1 text-center">
        {#if view === "chooseDestination"}
          Add a Core
        {:else if view === "localConfirm"}
          Set up a core on this computer
        {:else}
          Connect to a Remote Core
        {/if}
      </h1>
      {#if !viewState.locked}
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Close"
          size="lg"
          variant="subtle"
          surface="circle"
          disabled={busy !== null}
          onclick={exitFlow}
        />
      {:else}
        <div class="w-9 shrink-0" aria-hidden="true"></div>
      {/if}
    </div>
  {/if}

  {#if view === "chooseDestination"}
    <!-- Step 1 of initial setup: pick where the core runs. -->
    <p class="text-sm text-default-600">
      tomat needs a core: the local service that runs language models, speech
      services and tools. Where should it run?
    </p>

    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors hover:cursor-pointer {destination ===
        'local'
          ? 'bg-default-inverted-300'
          : 'bg-surface-inset hover:bg-surface-inset-strong'}"
        onclick={() => (destination = "local")}
        disabled={busy !== null}
      >
        <i
          class="flex i-material-symbols-computer-rounded text-2xl shrink-0 mt-0.5 {destination ===
          'local'
            ? 'text-default-inverted-800'
            : 'text-default-600'}"
        ></i>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span
            class="text-sm font-medium {destination === 'local'
              ? 'text-default-inverted-800'
              : 'text-default-800'}"
          >
            On this computer
            <span
              class="text-xs font-normal {destination === 'local'
                ? 'text-default-inverted-500'
                : 'text-default-500'}"
            >
              (recommended)
            </span>
          </span>
          <span
            class="text-xs {destination === 'local'
              ? 'text-default-inverted-500'
              : 'text-default-500'}"
          >
            Models and tools run locally. No data leaves your machine, and no
            other device can pair unless you allow it.
          </span>
        </div>
      </button>

      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors hover:cursor-pointer {destination ===
        'remote'
          ? 'bg-default-inverted-300'
          : 'bg-surface-inset hover:bg-surface-inset-strong'}"
        onclick={() => (destination = "remote")}
        disabled={busy !== null}
      >
        <i
          class="flex i-material-symbols-devices-rounded text-2xl shrink-0 mt-0.5 {destination ===
          'remote'
            ? 'text-default-inverted-800'
            : 'text-default-600'}"
        ></i>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span
            class="text-sm font-medium {destination === 'remote'
              ? 'text-default-inverted-800'
              : 'text-default-800'}"
          >
            On another computer
          </span>
          <span
            class="text-xs {destination === 'remote'
              ? 'text-default-inverted-500'
              : 'text-default-500'}"
          >
            Connect to a core already running on another machine in your
            network. Models and tools run there; this device only sends
            input and renders the UI.
          </span>
        </div>
      </button>
    </div>

    <Button
      variant="primary"
      icon={busy !== null
        ? "i-line-md:loading-loop"
        : "i-material-symbols-arrow-forward-rounded"}
      class="px-4 py-2.5 rounded-large"
      disabled={busy !== null}
      onclick={continueFromChoose}
    >
      {#if busy === "installing"}
        Setting up core…
      {:else if busy === "claiming"}
        Pairing…
      {:else}
        Continue
      {/if}
    </Button>
  {:else if view === "remoteAddress"}
    <!-- Remote step 1: enter the address and verify the connection. -->
    <p class="text-sm text-default-600">
      Enter the address of a core already running on another machine, then check
      the connection before pairing.
    </p>

    <p class="text-sm text-default-500">
      Need help setting up a remote core?
      <a
        href={CORE_SETUP_DOCS_URL}
        class="text-default-800 hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        Read the setup guide.
      </a>
    </p>

    <FormField label="Core Address">
      <Input
        value={remoteUrl}
        placeholder="https://192.168.1.20:7800"
        disabled={busy !== null}
        ariaLabel="Core address"
        oninput={(v) => (remoteUrl = v)}
      />
    </FormField>

    {#if connectionStatus.kind === "error"}
      <Alert variant="error" class="rounded-large">
        {connectionStatus.message}
      </Alert>
    {/if}

    {#if remoteUrl.trim()}
      <Button
        variant="primary"
        icon={busy === "checking"
          ? "i-line-md:loading-loop"
          : "i-material-symbols-arrow-forward-rounded"}
        class="px-4 py-2.5 rounded-large"
        disabled={busy !== null}
        onclick={checkConnection}
      >
        {busy === "checking" ? "Checking…" : "Check Connection"}
      </Button>
    {/if}
  {:else if view === "remotePair"}
    <!-- Remote step 2: name the core and enter its pairing code. -->
    <p class="text-sm text-default-600">
      Give this core a name and enter the 6-digit pairing code shown on the host
      machine.
    </p>

    <div class="flex flex-col gap-2">
      <FormField label="Name (optional)">
        <Input
          value={remoteName}
          placeholder={defaultRemoteName}
          disabled={busy !== null}
          ariaLabel="Core name"
          oninput={(v) => (remoteName = v)}
        />
      </FormField>

      <FormField label="Pairing Code">
        <Input
          value={remoteCode}
          maxlength={6}
          placeholder="000000"
          disabled={busy !== null}
          ariaLabel="Pairing code"
          class="tracking-widest"
          oninput={(v) => (remoteCode = v)}
        />
      </FormField>
    </div>

    {#if /^\d{6}$/.test(remoteCode)}
      <Button
        variant="primary"
        icon={busy === "claiming"
          ? "i-line-md:loading-loop"
          : "i-material-symbols-arrow-forward-rounded"}
        class="px-4 py-2.5 rounded-large"
        disabled={busy !== null}
        onclick={pairRemote}
      >
        {busy === "claiming" ? "Pairing…" : "Pair"}
      </Button>
    {/if}
  {:else if view === "localConfirm"}
    <!-- Step 2 (local branch): confirm install + per-install toggles. -->
    <p class="text-sm text-default-600">
      tomat will install the core service on this computer. Here's what
      that means:
    </p>

    <ul class="flex flex-col gap-2 text-sm text-default-700">
      <li class="flex gap-2">
        <i
          class="flex i-material-symbols-folder-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          Binaries and data go to
          <code class="bg-surface-inset-strong px-1 rounded-small">~/.tomat/core/</code>.
        </span>
      </li>
      <li class="flex gap-2">
        <i
          class="flex i-material-symbols-key-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          A pairing code is minted for this client; future clients pair via
          a fresh code.
        </span>
      </li>
    </ul>

    <!-- Service mode toggle -->
    <button
      type="button"
      class="flex items-start gap-3 bg-surface-inset rounded-large px-3 py-2.5 text-left hover:bg-surface-inset-strong hover:cursor-pointer transition-colors"
      onclick={() => (installServiceChoice = !installServiceChoice)}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installServiceChoice
          ? 'i-material-symbols-check-box-rounded text-default-800'
          : 'i-material-symbols-check-box-outline-blank-rounded text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800">
          Keep core running in the background
        </span>
        <span class="text-xs text-default-500">
          When on, a launchd / systemd / scheduled-task entry boots the core
          on login so other clients on this machine can connect anytime.
          When off, the client launches the core on demand at startup.
        </span>
      </div>
    </button>

    <!-- Network bind toggle -->
    <button
      type="button"
      class="flex items-start gap-3 bg-surface-inset rounded-large px-3 py-2.5 text-left hover:bg-surface-inset-strong hover:cursor-pointer transition-colors"
      onclick={() => (installNetworkChoice = !installNetworkChoice)}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installNetworkChoice
          ? 'i-material-symbols-check-box-rounded text-default-800'
          : 'i-material-symbols-check-box-outline-blank-rounded text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800">
          Allow other devices on this network to pair
        </span>
        <span class="text-xs text-default-500">
          When on, the core listens on <code
            class="bg-surface-inset-strong px-1 rounded-small">0.0.0.0:7800</code
          >
          so other clients in your LAN can connect. When off (default), only
          this device can reach it via <code
            class="bg-surface-inset-strong px-1 rounded-small">127.0.0.1</code
          >. Changeable later by editing the core's <code
            class="bg-surface-inset-strong px-1 rounded-small">settings.json</code
          >.
        </span>
      </div>
    </button>

    <Button
      variant="primary"
      icon={busy === "installing" || busy === "claiming"
        ? "i-line-md:loading-loop"
        : "i-material-symbols-download-rounded"}
      class="px-4 py-2.5 rounded-large"
      disabled={busy !== null}
      onclick={pairLocal}
    >
      {#if busy === "installing"}
        Installing…
      {:else if busy === "claiming"}
        Pairing…
      {:else}
        Install and Pair
      {/if}
    </Button>
  {/if}

  {#if error}
    <Alert variant="error" class="rounded-large">
      {error}
    </Alert>
  {/if}
</Bubble>
