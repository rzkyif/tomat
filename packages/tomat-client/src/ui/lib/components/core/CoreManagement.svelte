<script lang="ts">
  // Core management mode: pair / switch / unpair cores. This is the only
  // reachable mode while no core is paired (viewState.locked) and the first
  // screen on first launch. Also openable from Settings.

  import { onMount } from "svelte";
import { errMessage } from "@tomat/shared";
  import Bubble from "../ui/Bubble.svelte";
  import Alert from "../ui/Alert.svelte";
  import Button from "../ui/Button.svelte";
  import Chip from "../ui/Chip.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import {
    cores,
    mintCodeWithAdminToken,
    pairWithCode,
    type PairedCoreEntry,
    probeCore,
  } from "$lib/core";
  import { platform } from "$lib/platform";
  import { isTauri } from "$lib/shared/env";
  import { settingsState, viewState } from "$lib/state";

  const CLIENT_NAME = "Tomat Desktop";
  // Resolved from the platform on mount so a beta client targets the beta
  // core's port (7810) rather than the stable 7800. Falls back to the stable
  // default until resolved (and on the web stub).
  let localBaseUrl = $state("https://127.0.0.1:7800");

  let alignment = $derived(settingsState.getAlignment());

  let pairedCores = $state<PairedCoreEntry[]>([]);
  let currentId = $state<string | null>(null);
  let busy = $state<null | "installing" | "claiming" | "checking">(null);
  let error = $state("");
  let remoteUrl = $state("");
  let remoteName = $state("");
  let remoteCode = $state("");
  let confirmingUnpair = $state<string | null>(null);
  let connectionStatus = $state<
    | { kind: "idle" }
    | { kind: "ok"; version: string; checkedUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Sub-views. First-time users (no cores paired) start in `chooseDestination`
  // with a default of "this computer"; from there they either land on the
  // local-install confirmation page or the remote-address form. Returning
  // users (a core already paired) start in `list`.
  type View =
    | "list"
    | "chooseDestination"
    | "localConfirm"
    | "remoteAddress";
  let view = $state<View>("list");
  let destination = $state<"local" | "remote">("local");
  let installServiceChoice = $state(true);
  let installNetworkChoice = $state(false);
  let localAlreadyInstalled = $state(false);

  // Placeholder docs URL — page does not exist yet (tomat is not live).
  const CORE_SETUP_DOCS_URL = "https://au.tomat.ing/docs/core-setup";

  async function refresh(): Promise<void> {
    try {
      pairedCores = await cores().list();
      currentId = cores().currentEntry()?.id ?? null;
    } catch {
      /* settings not readable yet */
    }
  }

  // Pick the right initial view: returning users with a paired core land on
  // `list`; first-time users (locked) land on the destination chooser.
  async function decideInitialView(): Promise<void> {
    await refresh();
    if (pairedCores.length === 0) {
      view = "chooseDestination";
    } else {
      view = "list";
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
    void platform().pairing.localCoreBaseUrl().then((url) => {
      localBaseUrl = url;
    }).catch(() => {});
    const unsub = cores().subscribe(() => void refresh());
    return () => unsub();
  });

  // Unpair-from-list-view drains pairedCores → the destination chooser is
  // the right place to land next so the user can pair again. Skip while
  // any non-list view is active (the user is mid-flow).
  $effect(() => {
    if (
      pairedCores.length === 0 &&
      view === "list" &&
      viewState.locked
    ) {
      view = "chooseDestination";
    }
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
    await cores().select(entry.id);
    busy = null;
    await refresh();
    if (firstEver) {
      // First core ever paired: unlock the UI and run the new-user quick setup.
      viewState.setLocked(false);
      viewState.navigate("quickSetup");
    } else {
      viewState.navigate("chat");
    }
  }

  function backToChoose(): void {
    if (busy !== null) return;
    error = "";
    view = "chooseDestination";
  }

  // From the destination chooser: route to the right next step. If the user
  // picked "this computer" and the core is already installed, skip the
  // confirmation page entirely and go straight to "fast-path" pairing
  // (which uses the local admin token to mint a code without re-running the
  // installer).
  async function continueFromChoose(): Promise<void> {
    error = "";
    if (destination === "remote") {
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

  // Local core already exists on disk — make sure it's running, mint a
  // pairing code via its admin token, and claim. Skips the install script.
  async function pairLocalAlreadyInstalled(): Promise<void> {
    busy = "installing";
    try {
      await platform().pairing.startLocalCore();
      const adminToken = await platform().pairing.readAdminToken();
      if (!adminToken) {
        throw new Error(
          "Local core admin token not found. The install may be corrupt — " +
            "delete ~/.tomat/core/ and try again.",
        );
      }
      const { code } = await mintCodeWithAdminToken(localBaseUrl, adminToken);
      if (!code) throw new Error("response missing pairing code");
      busy = "claiming";
      await claimAndAdd(localBaseUrl, code, "Local Core");
      view = "list";
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
      view = "list";
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

  // Stale-check the connection state whenever the URL field changes — the
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

  async function switchTo(id: string): Promise<void> {
    error = "";
    confirmingUnpair = null;
    try {
      await cores().select(id);
    } catch (e) {
      error = errMessage(e);
    }
    await refresh();
  }

  async function unpair(id: string): Promise<void> {
    if (confirmingUnpair !== id) {
      confirmingUnpair = id;
      return;
    }
    confirmingUnpair = null;
    error = "";
    try {
      await cores().removePaired(id);
      const remaining = await cores().list();
      if (remaining.length === 0) {
        // Last core gone: lock the UI back to this screen.
        viewState.setLocked(true);
      } else if (!cores().currentEntry()) {
        // removePaired dropped the active core — activate another so the
        // rest of the app has a usable core again.
        await cores().select(remaining[0].id);
      }
    } catch (e) {
      error = errMessage(e);
    }
    await refresh();
  }
</script>

<Bubble
  selectedAlignment={alignment}
  extraClass="flex flex-col gap-4 w-[34rem] max-w-full"
>
  <!-- Header -->
  <div class="flex items-center gap-2">
    <i
      class="flex {view === 'localConfirm'
        ? 'i-material-symbols-download-rounded'
        : view === 'remoteAddress'
          ? 'i-material-symbols-cloud-rounded'
          : 'i-material-symbols-hub-rounded'} text-2xl text-default-700"
    ></i>
    <h1 class="text-lg font-medium text-default-800 flex-1">
      {#if view === "chooseDestination"}
        Welcome to Tomat
      {:else if view === "localConfirm"}
        Set up a core on this computer
      {:else if view === "remoteAddress"}
        Connect to a remote core
      {:else if viewState.locked}
        Welcome to Tomat
      {:else}
        Cores
      {/if}
    </h1>
    {#if view === "localConfirm" || view === "remoteAddress"}
      <IconButton
        icon="i-material-symbols-arrow-back-rounded"
        title="Back"
        size="lg"
        variant="subtle"
        surface="circle"
        disabled={busy !== null}
        onclick={backToChoose}
      />
    {:else if view === "list" && !viewState.locked}
      <IconButton
        icon="i-material-symbols-close-rounded"
        title="Back to Chat"
        size="lg"
        variant="subtle"
        surface="circle"
        onclick={() => viewState.navigate("chat")}
      />
    {/if}
  </div>

  {#if view === "chooseDestination"}
    <!-- Step 1 of initial setup: pick where the core runs. -->
    <p class="text-sm text-default-600">
      Tomat needs a core — the local service that runs language models, speech
      services and tools. Where should it run?
    </p>

    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors border-2 {destination ===
        'local'
          ? 'bg-accent-blue-100 border-accent-blue-300'
          : 'bg-default-200 border-transparent hover:bg-default-300'}"
        onclick={() => (destination = "local")}
        disabled={busy !== null}
      >
        <i
          class="flex i-material-symbols-computer-rounded text-2xl shrink-0 mt-0.5 {destination ===
          'local'
            ? 'text-accent-blue-300'
            : 'text-default-600'}"
        ></i>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="text-sm font-medium text-default-800">
            On this computer
            <span class="text-xs text-default-500 font-normal">
              (recommended)
            </span>
          </span>
          <span class="text-xs text-default-500">
            Models and tools run locally. No data leaves your machine — and
            no other device can pair unless you allow it.
          </span>
        </div>
      </button>

      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors border-2 {destination ===
        'remote'
          ? 'bg-accent-blue-100 border-accent-blue-300'
          : 'bg-default-200 border-transparent hover:bg-default-300'}"
        onclick={() => (destination = "remote")}
        disabled={busy !== null}
      >
        <i
          class="flex i-material-symbols-cloud-rounded text-2xl shrink-0 mt-0.5 {destination ===
          'remote'
            ? 'text-accent-blue-300'
            : 'text-default-600'}"
        ></i>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="text-sm font-medium text-default-800">
            On another computer
          </span>
          <span class="text-xs text-default-500">
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
    <!-- Step 2 (remote branch): URL + check + pair code. -->
    <p class="text-sm text-default-600">
      Enter the address of a tomat-core already running on another machine,
      then check the connection before pairing.
    </p>

    <div class="flex gap-2">
      <input
        type="text"
        placeholder="Core address (e.g. https://192.168.1.20:7800)"
        class="bg-default-200 rounded-large px-3 h-10 outline-none text-sm text-default-700 placeholder:text-default-400 flex-1"
        bind:value={remoteUrl}
        disabled={busy !== null}
      />
      <Button
        variant="secondary"
        class="px-4 rounded-large bg-default-300 hover:bg-default-400 shrink-0"
        disabled={busy !== null || !remoteUrl.trim()}
        onclick={checkConnection}
      >
        {busy === "checking" ? "Checking…" : "Check Connection"}
      </Button>
    </div>

    {#if connectionStatus.kind === "ok"}
      <div
        class="flex items-center gap-2 text-xs text-accent-green-300 bg-accent-green-100 rounded-medium px-3 py-1.5"
      >
        <i class="flex i-material-symbols-check-circle-rounded text-base"></i>
        <span class="truncate">
          Connected to core v{connectionStatus.version}.
        </span>
      </div>
    {:else if connectionStatus.kind === "error"}
      <div
        class="flex items-center gap-2 text-xs text-accent-red-300 bg-accent-red-100 rounded-medium px-3 py-1.5"
      >
        <i class="flex i-material-symbols-error-rounded text-base"></i>
        <span class="truncate">{connectionStatus.message}</span>
      </div>
    {/if}

    <p class="text-xs text-default-500">
      Need help setting up a remote core?
      <a
        href={CORE_SETUP_DOCS_URL}
        class="text-accent-blue-300 hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        Read the setup guide.
      </a>
    </p>

    <input
      type="text"
      placeholder="Name (optional)"
      class="bg-default-200 rounded-large px-3 h-10 outline-none text-sm text-default-700 placeholder:text-default-400"
      bind:value={remoteName}
      disabled={busy !== null}
    />
    <div class="flex gap-2">
      <input
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="6-digit code"
        class="bg-default-200 rounded-large px-3 h-10 outline-none text-sm text-default-700 placeholder:text-default-400 flex-1 tracking-widest"
        bind:value={remoteCode}
        disabled={busy !== null}
      />
      <Button
        variant="primary"
        class="px-4 rounded-large"
        disabled={busy !== null ||
          connectionStatus.kind !== "ok" ||
          connectionStatus.checkedUrl !== normalizedRemoteUrl() ||
          !/^\d{6}$/.test(remoteCode)}
        onclick={pairRemote}
      >
        Pair
      </Button>
    </div>
  {:else if view === "localConfirm"}
    <!-- Step 2 (local branch): confirm install + per-install toggles. -->
    <p class="text-sm text-default-600">
      Tomat will install the core service on this computer. Here's what
      that means:
    </p>

    <ul class="flex flex-col gap-2 text-sm text-default-700">
      <li class="flex gap-2">
        <i
          class="flex i-material-symbols-folder-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          Binaries and data go to
          <code class="bg-default-200 px-1 rounded-small">~/.tomat/core/</code>.
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
      class="flex items-start gap-3 bg-default-200 rounded-large px-3 py-2.5 text-left hover:bg-default-300 transition-colors"
      onclick={() => (installServiceChoice = !installServiceChoice)}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installServiceChoice
          ? 'i-material-symbols-check-box-rounded text-accent-blue-300'
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
      class="flex items-start gap-3 bg-default-200 rounded-large px-3 py-2.5 text-left hover:bg-default-300 transition-colors"
      onclick={() => (installNetworkChoice = !installNetworkChoice)}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installNetworkChoice
          ? 'i-material-symbols-check-box-rounded text-accent-blue-300'
          : 'i-material-symbols-check-box-outline-blank-rounded text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800">
          Allow other devices on this network to pair
        </span>
        <span class="text-xs text-default-500">
          When on, the core listens on <code
            class="bg-default-300 px-1 rounded-small">0.0.0.0:7800</code
          >
          so other clients in your LAN can connect. When off (default), only
          this device can reach it via <code
            class="bg-default-300 px-1 rounded-small">127.0.0.1</code
          >. Toggleable later in Settings → Server.
        </span>
      </div>
    </button>

    <div class="flex gap-2 justify-end">
      <Button
        variant="secondary"
        class="bg-default-300 hover:bg-default-400 px-4 rounded-large"
        disabled={busy !== null}
        onclick={backToChoose}
      >
        Back
      </Button>
      <Button
        variant="primary"
        icon={busy === "installing" || busy === "claiming"
          ? "i-line-md:loading-loop"
          : "i-material-symbols-download-rounded"}
        class="px-4 rounded-large"
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
    </div>
  {:else}
    <!-- view === "list": returning users — show current core + emergency
         unpair. Multi-core pairing is intentionally hidden per the
         "single core only for now" scope; unpairing returns to the
         destination chooser. -->
    {#if pairedCores.length > 0}
      <div class="flex flex-col gap-2">
        {#each pairedCores as core (core.id)}
          <div
            class="flex items-center gap-2 bg-default-200 rounded-large px-3 py-2"
          >
            <i
              class="flex i-material-symbols-hub-rounded text-lg text-default-600 shrink-0"
            ></i>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-default-800 truncate">{core.name}</span>
              <span class="text-xs text-default-500 truncate"
                >{core.baseUrl}</span
              >
            </div>
            {#if core.id === currentId}
              <Chip label="Active" size="xs" variant="accent" accent="green" />
            {/if}
            <Button
              variant={confirmingUnpair === core.id
                ? "destructive"
                : "secondary"}
              size="sm"
              class={confirmingUnpair === core.id
                ? "shrink-0"
                : "bg-default-300 hover:bg-default-400 shrink-0"}
              onclick={() => unpair(core.id)}
            >
              {confirmingUnpair === core.id ? "Confirm" : "Unpair"}
            </Button>
          </div>
        {/each}
      </div>
      <p class="text-xs text-default-500">
        Unpairing returns you to the setup screen so you can pair a different
        core.
      </p>
    {/if}
  {/if}

  {#if error}
    <Alert variant="error" class="rounded-large">
      {error}
    </Alert>
  {/if}
</Bubble>
