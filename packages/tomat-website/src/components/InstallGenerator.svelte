<script lang="ts">
  // The enhanced install generator, mounted over the no-JS baseline
  // (InstallGenerator.astro) when JS is available. Same nested target -> OS ->
  // command flow, but live: it auto-detects the OS, folds the core options into
  // the command as you toggle them, and copies to the clipboard. It reuses the
  // app's shared OptionCard / Toggle / IconButton primitives so the controls
  // match the client, and the same lib/install helpers as the baseline so the
  // commands never drift between the two.
  import { onMount } from "svelte";
  import OptionCard from "@tomat/shared/ui/components/primitives/OptionCard.svelte";
  import Toggle from "@tomat/shared/ui/components/primitives/Toggle.svelte";
  import { ripple } from "@tomat/shared/ui/actions/ripple.ts";
  import { RIPPLE_MS } from "@tomat/shared/ui/animations.ts";
  import {
    androidApkUrl,
    type Channel,
    CLIENT_OS,
    clientCommand,
    clientUninstallCommand,
    CORE_OS,
    coreCommand,
    coreUninstallCommand,
    detectOs,
    type Os,
    type Target,
  } from "../lib/install.ts";

  // "install" (the /install page) or "uninstall" (the manual's removal page).
  // The two share the whole target -> OS -> command flow; uninstall just swaps
  // the command builders, drops the install-only Core toggles for a flags note,
  // and relabels. Defaults to install so the /install page needs no prop.
  let { mode = "install" }: { mode?: "install" | "uninstall" } = $props();
  const verb = mode === "install" ? "Install" : "Uninstall";

  let target = $state<Target>("client");
  // Kept per target (as the baseline's two radio groups are): the client picker
  // includes Android, the core picker does not.
  let clientOs = $state<Os>("macos");
  let coreOs = $state<Os>("macos");
  // Stable has not shipped yet, so the channel is locked to latest; the picker
  // shows stable as a disabled option for when it does.
  const channel: Channel = "latest";
  let bindAll = $state(false);
  let service = $state(true);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const os = detectOs(navigator.userAgent, navigator.platform);
    clientOs = os;
    // The core has no Android build; fall back to a desktop OS for its picker.
    coreOs = os === "android" ? "linux" : os;
  });

  const os = $derived(target === "client" ? clientOs : coreOs);
  const osChoices = $derived(target === "client" ? CLIENT_OS : CORE_OS);
  const isAndroid = $derived(target === "client" && clientOs === "android");

  const command = $derived(
    mode === "uninstall"
      ? (target === "client"
        ? clientUninstallCommand(clientOs, channel)
        : coreUninstallCommand(coreOs, channel))
      : (target === "client"
        ? clientCommand(clientOs, channel)
        : coreCommand(coreOs, channel, { bindAll, service })),
  );

  const steps = $derived.by(() => {
    const open = os === "windows" ? "Open PowerShell." : os === "macos" ? "Open Terminal." : "Open your terminal.";
    const run = "Paste the command above and press Enter.";
    if (mode === "uninstall") {
      const tail = target === "core"
        ? "It stops the Core, then removes it and its data from this computer."
        : "It removes the app; your settings stay unless you add the flag below.";
      return [open, run, tail];
    }
    if (target === "core") {
      return [open, run, "Set an admin password when prompted; you'll need it to pair more devices.", "When it finishes, note the pairing code it prints."];
    }
    return [open, run, "When it finishes, launch tomat and pick where its Core should run."];
  });

  // Uninstall flags note, mirroring the install Options note: what the flag
  // does, plus how to pass it through the piped one-liner per platform.
  const flag = $derived(target === "client" ? "--purge" : "--keep-data");
  const flagEnv = $derived(target === "client" ? "TOMAT_PURGE" : "TOMAT_KEEP_DATA");
  const flagWhat = $derived(
    target === "client"
      ? "also deletes your saved settings and paired cores"
      : "keeps the Core's sessions and memories instead of removing them",
  );

  function selectOs(id: Os) {
    if (target === "client") clientOs = id;
    else coreOs = id;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (_) {
      // clipboard unavailable: the command stays selectable for manual copy
    }
  }

  const labelCls = "text-xs font-medium uppercase tracking-wide text-default-500";
  // OS + channel buttons share one look: an inset chip that flips to the inverted
  // "primary" fill when active (the segmented controls' selected colour). The
  // pointer cursor is added per-button only on the clickable ones (the OS picker);
  // the channel picker is locked, so its buttons keep the default cursor.
  const btnBase =
    "flex items-center justify-center gap-2 px-3 py-2 rounded-medium text-sm transition-colors";
  const btnActive = `${btnBase} bg-default-inverted-300 text-default-inverted-900`;
  const btnIdle = `${btnBase} bg-surface-inset text-default-700 hover:bg-surface-inset-strong`;
</script>

<div class="flex flex-col gap-6">
  <!-- Step 1: client or core, with the "not sure" hint grouped under it. -->
  <div class="flex flex-col gap-2">
    <span class={labelCls}>{verb}</span>
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <OptionCard
          selected={target === "client"}
          icon="i-mdi-monitor-dashboard"
          title="Client"
          description={mode === "uninstall"
            ? "The app you look at. Removing it leaves your settings in place unless you choose to wipe them."
            : "The app you look at. On first launch it can install a Core on this same computer for you, so one install gets you a full local setup."}
          onclick={() => (target = "client")}
        >
          {#snippet trailing()}
            {#if mode === "install"}
              <span
                class={`text-xs px-2 py-0.5 rounded-full ${
                  target === "client"
                    ? "bg-default-300 text-default-900"
                    : "bg-default-inverted-300 text-default-inverted-900"
                }`}
              >Recommended</span>
            {/if}
          {/snippet}
        </OptionCard>
        <OptionCard
          selected={target === "core"}
          icon="i-mdi-server"
          title="Core"
          description={mode === "uninstall"
            ? "The service that does the work. Removing it stops the Core and deletes its data from this computer."
            : "The service that does the work. Install it on its own when you want it on a separate, more powerful machine that Clients connect to."}
          onclick={() => (target = "core")}
        />
      </div>
      {#if mode === "install"}
        <div class="flex items-start gap-2 rounded-large bg-surface-inset px-4 py-3 text-sm text-default-600">
          <i class="i-material-symbols-info-outline-rounded text-base shrink-0 mt-0.5 text-default-500"></i>
          <span>
            Not sure? Install the <strong class="text-default-800">Client</strong> and start there. It
            walks you through everything, including setting up a Core on this same computer.
          </span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Operating system. -->
  <div class="flex flex-col gap-2">
    <span class={labelCls}>Operating System</span>
    <div class={`grid gap-2 ${target === "client" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
      {#each osChoices as o (o.id)}
        <button type="button" class={`${os === o.id ? btnActive : btnIdle} hover:cursor-pointer`} aria-pressed={os === o.id} onclick={() => selectOs(o.id)}>
          <i class={`${o.icon} text-lg`}></i>
          {o.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Channel, locked to latest for now (stable not yet released). -->
  <div class="flex flex-col gap-2">
    <span class={labelCls}>Channel</span>
    <div class="grid grid-cols-2 gap-2">
      <button type="button" class={`${btnBase} bg-surface-inset text-default-500 opacity-60 cursor-not-allowed`} disabled aria-disabled="true">
        <i class="i-material-symbols-shield-outline-rounded text-lg"></i>
        Stable
      </button>
      <button type="button" class={btnActive} aria-pressed="true">
        <i class="i-material-symbols-bolt-rounded text-lg"></i>
        Latest
      </button>
    </div>
  </div>

  <!-- Core-only install options, folded into the command live. -->
  {#if mode === "install" && target === "core"}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Options</span>
      <div class="flex flex-col gap-3 rounded-large bg-surface-inset px-4 py-3">
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-default-700">Allow access from other machines</span>
          <div class="w-24 shrink-0">
            <Toggle checked={bindAll} onchange={(v) => (bindAll = v)} ariaLabel="Allow access from other machines" />
          </div>
        </label>
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-default-700">Run in the background at login</span>
          <div class="w-24 shrink-0">
            <Toggle checked={service} onchange={(v) => (service = v)} ariaLabel="Run in the background at login" />
          </div>
        </label>
      </div>
    </div>
  {/if}

  <!-- Uninstall flags note, mirroring the install Options note. Not folded into
       the command (it changes what is deleted), so it is shown as guidance. -->
  {#if mode === "uninstall" && !isAndroid}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Options</span>
      <div class="flex flex-col gap-2 rounded-large bg-surface-inset px-4 py-3 text-sm text-default-700">
        <p class="m-0">
          By default this {target === "core" ? "removes the Core and its data" : "keeps your settings"}. To change that, add a flag:
        </p>
        <p class="m-0">
          <span class="font-mono text-default-900">{flag}</span>
          {flagWhat}.
        </p>
        <p class="m-0">
          On macOS and Linux append it after <span class="font-mono">bash</span>, e.g.
          <span class="font-mono text-default-900">... | bash -s -- {flag}</span>. On Windows prefix the line, e.g.
          <span class="font-mono text-default-900">$env:{flagEnv}="1"; irm ...</span>.
        </p>
      </div>
    </div>
  {/if}

  <!-- The command (or, for Android, the APK download / removal note). -->
  {#if isAndroid && mode === "uninstall"}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Remove</span>
      <div class="flex flex-col gap-3 rounded-large bg-surface-inset px-4 py-3">
        <p class="text-sm text-default-700 m-0">There is no script on Android. Remove tomat like any other app.</p>
        <ol class="m-0 flex flex-col gap-1 text-sm text-default-600 list-decimal pl-5">
          <li>Press and hold the tomat icon.</li>
          <li>Choose Uninstall (or drag it to Uninstall).</li>
          <li>Confirm to remove the app and its data.</li>
        </ol>
      </div>
    </div>
  {:else if isAndroid}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Download</span>
      <div class="flex flex-col gap-3 rounded-large bg-surface-inset px-4 py-3">
        <p class="text-sm text-default-700 m-0">The Android app is a signed APK you install directly.</p>
        <a
          href={androidApkUrl(channel)}
          class="inline-flex items-center justify-center gap-2 rounded-large bg-default-inverted-300 px-4 py-2.5 text-sm text-default-inverted-900 hover:cursor-pointer"
        >
          <i class="i-material-symbols-download-rounded text-base"></i>
          Download the Android APK
        </a>
        <ol class="m-0 flex flex-col gap-1 text-sm text-default-600 list-decimal pl-5">
          <li>Open the downloaded file on your phone.</li>
          <li>If asked, allow installing apps from this source.</li>
          <li>Confirm the install, then open tomat.</li>
        </ol>
      </div>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>{verb} Command</span>
      <!-- The whole card copies on click, so the press feedback (ripple) and the
           hover are on the card itself; the icon is just an indicator. -->
      <div
        role="button"
        tabindex="0"
        onclick={copy}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            copy();
          }
        }}
        use:ripple={{ durationMs: RIPPLE_MS }}
        title={`Copy ${verb.toLowerCase()} command`}
        aria-label={`Copy ${verb.toLowerCase()} command`}
        class="group flex items-center gap-3 px-4 py-3 rounded-large bg-surface-inset transition-interactive hov:bg-surface-inset-strong hov:cursor-pointer"
      >
        <code class="font-mono text-sm text-default-800 overflow-x-auto whitespace-nowrap flex-1 no-scrollbar">{command}</code>
        <i
          class={`text-lg shrink-0 ${
            copied
              ? "i-material-symbols-check-rounded text-default-900"
              : "i-material-symbols-content-copy-outline-rounded text-default-600 group-hover:text-default-900"
          }`}
          aria-hidden="true"
        ></i>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <span class={labelCls}>How to {verb}</span>
      <ol class="m-0 flex flex-col gap-2 text-sm text-default-700 list-decimal pl-5">
        {#each steps as step (step)}
          <li>{step}</li>
        {/each}
        {#if mode === "install"}
          <li>If you ever need to uninstall, follow <a href="/manual/settings/uninstalling" class="underline hov:text-default-700">the uninstallation guide</a>.</li>
        {/if}
      </ol>
    </div>
  {/if}
</div>
