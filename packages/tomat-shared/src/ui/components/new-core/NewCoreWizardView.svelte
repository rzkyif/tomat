<script lang="ts" module>
  // Presentational body of the add-a-core wizard. The four steps (destination
  // chooser -> local-confirm | remote-address -> remote-pair) plus the shared
  // header, error footer, and bubble/mobile frame are all pure markup here; the
  // client owns the state machine, the form drafts, LAN discovery, connection
  // probing, and the pairing flows, and feeds them in as data while taking the
  // step transitions back out as callbacks. Props in, callbacks out.

  // Which wizard step is showing.
  export type NewCoreWizardStep =
    "chooseDestination" | "localConfirm" | "remoteAddress" | "remotePair";

  // The in-flight pairing/install operation, or null when idle. Drives the
  // primary buttons' spinner + label and disables controls.
  export type NewCoreWizardBusy = null | "installing" | "claiming" | "checking";

  // The running local install's phase, streamed from the installer while
  // busy === "installing". The install button shows "<label> (<pct>%)" so the
  // user sees what is actually happening instead of a bare "Installing…".
  export interface NewCoreInstallProgress {
    label: string;
    done: number;
    total: number;
  }

  // One LAN-discovered core row (pre-formatted host label + version).
  export interface NewCoreDiscoveredRow {
    pin: string;
    hostLabel: string;
    version: string;
  }
</script>

<script lang="ts">
  import type { Alignment } from "../../types.ts";
  import Bubble from "../primitives/Bubble.svelte";
  import Button from "../primitives/Button.svelte";
  import ErrorDetailView from "../chat/messages/ErrorDetailView.svelte";
  import Expand from "../primitives/Expand.svelte";
  import FormField from "../primitives/FormField.svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import Input from "../primitives/Input.svelte";
  import ListItem from "../primitives/ListItem.svelte";

  let {
    step,
    onMobile = false,
    hasSystemBack = false,
    locked = false,
    alignment = "center",
    busy = null,
    error = "",
    canStepBack = false,
    // Choose-destination step.
    destination = "local",
    // Remote-address step.
    coreSetupDocsUrl,
    discovering = false,
    didSweep = false,
    discovered = [],
    connectionError = null,
    // Remote-pair step.
    defaultRemoteName = "",
    remoteCodeValid = false,
    // Local-confirm step.
    installServiceChoice = false,
    installNetworkChoice = false,
    installBehindProxyChoice = false,
    installProgress = null,
    minAdminPasswordLength,
    installPasswordValid = false,
    onStepBack,
    onClose,
    onChooseDestination,
    onContinueFromChoose,
    onPingNetwork,
    onUseDiscovered,
    onCheckConnection,
    onToggleService,
    onToggleNetwork,
    onToggleBehindProxy,
    onPairLocal,
    onContinueInBackground,
    onPairRemote,
    // Controlled text fields.
    remoteUrl = $bindable(""),
    remoteName = $bindable(""),
    remoteCode = $bindable(""),
    installPassword = $bindable(""),
    installPasswordConfirm = $bindable(""),
  }: {
    step: NewCoreWizardStep;
    onMobile?: boolean;
    hasSystemBack?: boolean;
    locked?: boolean;
    alignment?: Alignment;
    busy?: NewCoreWizardBusy;
    error?: string;
    canStepBack?: boolean;
    destination?: "local" | "remote";
    coreSetupDocsUrl: string;
    discovering?: boolean;
    didSweep?: boolean;
    discovered?: NewCoreDiscoveredRow[];
    connectionError?: string | null;
    defaultRemoteName?: string;
    remoteCodeValid?: boolean;
    installServiceChoice?: boolean;
    installNetworkChoice?: boolean;
    installBehindProxyChoice?: boolean;
    installProgress?: NewCoreInstallProgress | null;
    minAdminPasswordLength: number;
    installPasswordValid?: boolean;
    onStepBack?: () => void;
    onClose?: () => void;
    onChooseDestination?: (d: "local" | "remote") => void;
    onContinueFromChoose?: () => void;
    onPingNetwork?: () => void;
    onUseDiscovered?: (row: NewCoreDiscoveredRow) => void;
    onCheckConnection?: () => void;
    onToggleService?: () => void;
    onToggleNetwork?: () => void;
    onToggleBehindProxy?: () => void;
    onPairLocal?: () => void;
    onContinueInBackground?: () => void;
    onPairRemote?: () => void;
    remoteUrl?: string;
    remoteName?: string;
    remoteCode?: string;
    installPassword?: string;
    installPasswordConfirm?: string;
  } = $props();

  const noop = (): void => {};

  // "<label> (<pct>%)" for the install button while phases stream in, or null
  // before the first phase lands (the button falls back to "Installing…").
  const installProgressText = $derived.by(() => {
    if (!installProgress || installProgress.total <= 0) return null;
    const pct = Math.min(100, Math.round((installProgress.done / installProgress.total) * 100));
    return `${installProgress.label} (${pct}%)`;
  });
</script>

{#if onMobile}
  <!-- Full-screen mobile activity: a scrolling body (welcome header + the step's
       fields) with the primary action pinned to a footer. The frame owns the
       safe-area insets and shrinks by the keyboard height, so the footer rides
       above the keyboard like the chat composer; this screen only adds its own
       padding, never the insets. -->
  <div class="flex-1 min-h-0 flex flex-col w-full">
    <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-5 px-5 pt-4 pb-6">
      {@render mobileHeader()}
      {@render wizardBody()}
    </div>
    <div class="shrink-0 px-5 pt-2 pb-3 bg-surface">
      {@render mobileFooterButton()}
    </div>
  </div>
{:else}
  <Bubble selectedAlignment={alignment} extraClass="flex flex-col gap-4 w-[22.5rem] max-w-full">
    {@render wizardBody()}
  </Bubble>
{/if}

{#snippet mobileHeader()}
  {#if locked && !canStepBack}
    <!-- First-run welcome: mobile enters the wizard here (the destination chooser
         is desktop-only), so greet the user instead of opening on a bare form. The
         intro is a normal left-aligned paragraph so it reads as one description
         with the step lead below it, not a second, separately-styled block. -->
    <div class="flex flex-col items-center gap-3 pt-4 pb-1">
      <span
        class="w-16 h-16 bg-default-800 shrink-0"
        style="mask:url(/tomat.svg) center/contain no-repeat;-webkit-mask:url(/tomat.svg) center/contain no-repeat;"
        aria-hidden="true"
      ></span>
      <h1 class="text-2xl font-semibold text-default-800">Welcome to tomat</h1>
    </div>
    <p class="text-sm text-default-600">
      tomat runs on a Core: the service that powers your models, speech, and tools. Connect this
      device to one to get started.
    </p>
  {:else}
    <!-- Later step / additional-core: a left-aligned top bar (back or close) over
         a screen title, matching the other mobile screens. On Android the OS owns
         back navigation (hasSystemBack), so the in-UI back/close are dropped and
         the system gesture / button handles both stepping back and closing; iOS
         has no system back, so they show. -->
    <div class="flex flex-col gap-2">
      {#if canStepBack && !hasSystemBack}
        <button
          type="button"
          class="flex items-center gap-2 h-11 -ml-1 self-start text-default-700 transition-interactive hov:text-default-900 hov:cursor-pointer"
          disabled={busy !== null}
          onclick={() => (onStepBack ?? noop)()}
        >
          <i class="i-material-symbols-arrow-back-rounded text-xl"></i>
          <span class="font-medium">Back</span>
        </button>
      {:else if !locked && !hasSystemBack}
        <div class="flex h-11 items-center justify-end -mr-2">
          <IconButton
            icon="i-material-symbols-close-rounded"
            title="Close"
            size="lg"
            variant="subtle"
            surface="circle"
            disabled={busy !== null}
            onclick={() => (onClose ?? noop)()}
          />
        </div>
      {/if}
      <h1 class="text-xl font-semibold text-default-800">
        {#if step === "remotePair"}
          Enter the Pairing Code
        {:else}
          Connect to a Core
        {/if}
      </h1>
    </div>
  {/if}
{/snippet}

{#snippet mobileFooterButton()}
  {#if step === "remotePair"}
    <Button
      variant="primary"
      icon={busy === "claiming"
        ? "i-line-md:loading-loop"
        : "i-material-symbols-arrow-forward-rounded"}
      class="w-full px-4 py-3 rounded-large"
      disabled={busy !== null || !remoteCodeValid}
      onclick={() => (onPairRemote ?? noop)()}
    >
      {busy === "claiming" ? "Pairing…" : "Pair"}
    </Button>
  {:else}
    <Button
      variant="primary"
      icon={busy === "checking"
        ? "i-line-md:loading-loop"
        : "i-material-symbols-arrow-forward-rounded"}
      class="w-full px-4 py-3 rounded-large"
      disabled={busy !== null || !remoteUrl.trim()}
      onclick={() => (onCheckConnection ?? noop)()}
    >
      {busy === "checking" ? "Checking…" : "Check Connection"}
    </Button>
  {/if}
{/snippet}

{#snippet wizardBody()}
  <!-- Desktop header. Mobile renders its own welcome / top bar in mobileHeader. -->
  {#if !onMobile}
    {#if step === "chooseDestination" && locked}
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
      <div class="flex items-center gap-2">
        {#if canStepBack}
          <IconButton
            icon="i-material-symbols-arrow-back-rounded"
            title="Back"
            size="lg"
            variant="subtle"
            surface="circle"
            disabled={busy !== null}
            onclick={() => (onStepBack ?? noop)()}
          />
        {:else}
          <div class="w-9 shrink-0" aria-hidden="true"></div>
        {/if}
        <h1 class="text-lg font-medium text-default-800 flex-1 text-center">
          {#if step === "chooseDestination"}
            Add a Core
          {:else if step === "localConfirm"}
            Install a Core
          {:else}
            Connect to a Remote Core
          {/if}
        </h1>
        {#if !locked}
          <IconButton
            icon="i-material-symbols-close-rounded"
            title="Close"
            size="lg"
            variant="subtle"
            surface="circle"
            disabled={busy !== null}
            onclick={() => (onClose ?? noop)()}
          />
        {:else}
          <div class="w-9 shrink-0" aria-hidden="true"></div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if step === "chooseDestination"}
    <!-- Step 1 of initial setup: pick where the core runs. -->
    <p class="text-sm text-default-600">
      tomat needs a Core: the local service that runs language models, speech services and tools.
      Where should it run?
    </p>

    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors hover:cursor-pointer {destination ===
        'local'
          ? 'bg-default-inverted-300'
          : 'bg-surface-inset hover:bg-surface-inset-strong'}"
        onclick={() => (onChooseDestination ?? noop)("local")}
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
            Models and tools run locally. No data leaves your machine, and no other device can pair
            unless you allow it.
          </span>
        </div>
      </button>

      <button
        type="button"
        class="flex items-start gap-3 rounded-large px-3 py-3 text-left transition-colors hover:cursor-pointer {destination ===
        'remote'
          ? 'bg-default-inverted-300'
          : 'bg-surface-inset hover:bg-surface-inset-strong'}"
        onclick={() => (onChooseDestination ?? noop)("remote")}
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
            Connect to a Core already running on another machine in your network. Models and tools
            run there; this device only sends input and renders the UI.
          </span>
        </div>
      </button>
    </div>

    <Button
      variant="primary"
      icon={busy !== null ? "i-line-md:loading-loop" : "i-material-symbols-arrow-forward-rounded"}
      class="px-4 py-2.5 rounded-large"
      disabled={busy !== null}
      onclick={() => (onContinueFromChoose ?? noop)()}
    >
      {#if busy === "installing"}
        Setting up Core…
      {:else if busy === "claiming"}
        Pairing…
      {:else}
        Continue
      {/if}
    </Button>
  {:else if step === "remoteAddress"}
    <!-- Remote step 1: enter the address and verify the connection. -->
    <p class="text-sm text-default-600">
      Enter the address where your Core is running, then check the connection. You can also press
      the button on the address bar to find a Core on the same network.
    </p>

    <p class="text-sm text-default-500">
      New to this?
      <a
        href={coreSetupDocsUrl}
        class="text-default-800 hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        Read the setup guide.
      </a>
    </p>

    <FormField label="Core Address">
      <!-- Address field with a "ping" button nested inside it (mirrors the
           regenerate button in the session bar's title field) that sweeps the
           local network for reachable cores. -->
      <Input
        value={remoteUrl}
        placeholder="https://192.168.1.20:7800"
        disabled={busy !== null}
        ariaLabel="Core address"
        oninput={(v) => (remoteUrl = v)}
      >
        {#snippet trailing()}
          <IconButton
            icon={discovering ? "i-line-md:loading-loop" : "i-material-symbols-wifi-find-rounded"}
            title={discovering ? "Searching your network…" : "Find Cores on your network"}
            size="sm"
            disabled={discovering || busy !== null}
            onclick={() => (onPingNetwork ?? noop)()}
          />
        {/snippet}
      </Input>
    </FormField>

    <!-- Discovered cores: an animated panel that expands once a sweep
         completes. Clicking a row fills the address field above. -->
    <Expand open={didSweep && !discovering}>
      <div class="flex flex-col gap-1">
        {#if discovered.length === 0}
          <p class="text-sm text-default-500 px-3 py-2">No Cores found on your network.</p>
        {:else}
          {#each discovered as core (core.pin)}
            <ListItem direction="row" role="option" onclick={() => (onUseDiscovered ?? noop)(core)}>
              <span class="truncate flex-1 text-sm text-default-800">
                {core.hostLabel}
              </span>
              <span class="text-xs font-mono text-default-500 shrink-0">
                v{core.version}
              </span>
            </ListItem>
          {/each}
        {/if}
      </div>
    </Expand>

    {#if connectionError}
      <ErrorDetailView message={connectionError} />
    {/if}

    <!-- Desktop shows the CTA inline once an address is typed; mobile pins it to
         the footer (see mobileFooterButton). -->
    {#if !onMobile && remoteUrl.trim()}
      <Button
        variant="primary"
        icon={busy === "checking"
          ? "i-line-md:loading-loop"
          : "i-material-symbols-arrow-forward-rounded"}
        class="px-4 py-2.5 rounded-large"
        disabled={busy !== null}
        onclick={() => (onCheckConnection ?? noop)()}
      >
        {busy === "checking" ? "Checking…" : "Check Connection"}
      </Button>
    {/if}
  {:else if step === "remotePair"}
    <!-- Remote step 2: name the core and enter its pairing code. -->
    <p class="text-sm text-default-600">
      Nearly there. Give this Core a name you'll recognize, then enter the 6-digit pairing code
      shown on it.
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

    <!-- Desktop shows the CTA inline once the code is valid; mobile pins it to the
         footer (see mobileFooterButton). -->
    {#if !onMobile && remoteCodeValid}
      <Button
        variant="primary"
        icon={busy === "claiming"
          ? "i-line-md:loading-loop"
          : "i-material-symbols-arrow-forward-rounded"}
        class="px-4 py-2.5 rounded-large"
        disabled={busy !== null}
        onclick={() => (onPairRemote ?? noop)()}
      >
        {busy === "claiming" ? "Pairing…" : "Pair"}
      </Button>
    {/if}
  {:else if step === "localConfirm"}
    <!-- Step 2 (local branch): confirm install + per-install toggles. -->
    <p class="text-sm text-default-600">
      tomat will install the Core service on this computer. Here's what that means:
    </p>

    <ul class="flex flex-col gap-2 text-sm text-default-700">
      <li class="flex gap-2">
        <i
          class="flex i-material-symbols-cloud-download-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          tomat downloads the Core from
          <code class="bg-surface-inset-strong px-1 rounded-small">get.au.tomat.ing</code>
          and installs it on this computer.
        </span>
      </li>
      <li class="flex gap-2">
        <i class="flex i-material-symbols-folder-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          Binaries and data go to
          <code class="bg-surface-inset-strong px-1 rounded-small">~/.tomat/core/</code>.
        </span>
      </li>
      <li class="flex gap-2">
        <i class="flex i-material-symbols-key-rounded text-base text-default-500 shrink-0 mt-0.5"
        ></i>
        <span>
          A pairing code is minted for this Client. The admin password you set below lets you pair
          more devices later.
        </span>
      </li>
    </ul>

    <!-- Service mode toggle -->
    <button
      type="button"
      class="flex items-start gap-3 bg-surface-inset rounded-large px-3 py-2.5 text-left hover:bg-surface-inset-strong hover:cursor-pointer transition-colors"
      onclick={() => (onToggleService ?? noop)()}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installServiceChoice
          ? 'i-material-symbols-check-box-rounded text-default-800'
          : 'i-material-symbols-check-box-outline-blank text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800">
          Keep Core running in the background
        </span>
        <span class="text-xs text-default-500">
          When on, a launchd / systemd / scheduled-task entry boots the Core on login so other
          Clients on this machine can connect anytime. When off, the Client launches the Core on
          demand at startup.
        </span>
      </div>
    </button>

    <!-- Network bind toggle -->
    <button
      type="button"
      class="flex items-start gap-3 bg-surface-inset rounded-large px-3 py-2.5 text-left hover:bg-surface-inset-strong hover:cursor-pointer transition-colors"
      onclick={() => (onToggleNetwork ?? noop)()}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installNetworkChoice
          ? 'i-material-symbols-check-box-rounded text-default-800'
          : 'i-material-symbols-check-box-outline-blank text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800">
          Allow other devices on this network to pair
        </span>
        <span class="text-xs text-default-500">
          When on, the Core listens on <code class="bg-surface-inset-strong px-1 rounded-small"
            >0.0.0.0:7800</code
          >
          so other Clients in your LAN can connect. When off (default), only this device can reach it
          via <code class="bg-surface-inset-strong px-1 rounded-small">127.0.0.1</code>. Changeable
          later by editing the Core's
          <code class="bg-surface-inset-strong px-1 rounded-small">settings.json</code>.
        </span>
      </div>
    </button>

    <!-- Behind-proxy toggle. This device pairs directly over loopback either
         way; the option switches the Core so OTHER devices reaching it through
         an HTTPS proxy trust the proxy's certificate instead of the Core's. -->
    <button
      type="button"
      class="flex items-start gap-3 bg-surface-inset rounded-large px-3 py-2.5 text-left hover:bg-surface-inset-strong hover:cursor-pointer transition-colors"
      onclick={() => (onToggleBehindProxy ?? noop)()}
      disabled={busy !== null}
    >
      <i
        class="flex text-xl shrink-0 mt-0.5 {installBehindProxyChoice
          ? 'i-material-symbols-check-box-rounded text-default-800'
          : 'i-material-symbols-check-box-outline-blank text-default-500'}"
      ></i>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-sm font-medium text-default-800"> Served through an HTTPS proxy </span>
        <span class="text-xs text-default-500">
          Turn this on only if other devices will reach this Core through a reverse proxy that
          serves HTTPS, such as Caddy or Cloudflare. Those devices then trust the proxy's
          certificate; this device stays paired directly. Leave it off for a normal local Core.
        </span>
      </div>
    </button>

    <!-- Admin password. Required so the user can pair new devices remotely
         later (from a paired client) without reading the admin token off disk. -->
    <div class="flex flex-col gap-2">
      <FormField label="Admin password">
        <Input
          type="password"
          value={installPassword}
          placeholder="••••••••"
          disabled={busy !== null}
          ariaLabel="Admin password"
          oninput={(v) => (installPassword = v)}
        />
      </FormField>
      <FormField label="Confirm admin password">
        <Input
          type="password"
          value={installPasswordConfirm}
          placeholder="••••••••"
          disabled={busy !== null}
          ariaLabel="Confirm admin password"
          oninput={(v) => (installPasswordConfirm = v)}
        />
      </FormField>
      {#if installPassword && installPassword.length < minAdminPasswordLength}
        <span class="text-xs text-default-500">
          Use at least {minAdminPasswordLength} characters.
        </span>
      {:else if installPasswordConfirm && installPassword !== installPasswordConfirm}
        <span class="text-xs text-accent-red-700">Passwords do not match.</span>
      {:else}
        <span class="text-xs text-default-500">
          Remember this. You'll need it to pair new devices.
        </span>
      {/if}
    </div>

    <Button
      variant="primary"
      icon={busy === "installing" || busy === "claiming"
        ? "i-line-md:loading-loop"
        : "i-material-symbols-download-rounded"}
      class="px-4 py-2.5 rounded-large"
      disabled={busy !== null || !installPasswordValid}
      onclick={() => (onPairLocal ?? noop)()}
    >
      {#if busy === "installing"}
        {installProgressText ?? "Installing…"}
      {:else if busy === "claiming"}
        Pairing…
      {:else}
        Install and Pair
      {/if}
    </Button>

    {#if busy === "installing"}
      <!-- The setup window is always-on-top and can't be moved, and installing a
           Core can take a while on a slow connection. Let the user send it to the
           background rather than wait behind it: the tray icon brings it back, and
           it also returns on its own once the install finishes. Only shown once
           the install is actually running (busy === "installing"). -->
      <Button
        variant="primary"
        icon="i-material-symbols-keyboard-arrow-down-rounded"
        class="px-4 py-2.5 rounded-large"
        onclick={() => (onContinueInBackground ?? noop)()}
      >
        Continue in the Background
      </Button>
    {/if}
  {/if}

  {#if error}
    <ErrorDetailView message={error} />
  {/if}
{/snippet}
