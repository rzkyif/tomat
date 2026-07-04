<script lang="ts">
  // The enhanced install generator, mounted over the no-JS baseline
  // (InstallGenerator.astro) when JS is available. Each instance covers ONE
  // target, the Client or the Core, given as a prop; the axes it exposes are the
  // operating system, the channel, and (for the Core, or an uninstall) a couple
  // of options. It auto-detects the OS, folds the options into the command as you
  // toggle them, and copies to the clipboard. It reuses the app's shared Toggle
  // primitive so the controls match the client, and the same lib/install helpers
  // as the baseline so the commands never drift between the two.
  import { onMount, untrack } from "svelte";
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
    finishHowto,
    installerHowto,
    type NativeInstaller,
    nativeInstallers,
    openTerminalStep,
    type Os,
    scriptHowto,
    type Target,
    uninstallStepsTail,
  } from "../lib/install.ts";

  // `target` locks the instance to the Client or the Core (no picker). `mode` is
  // "install" (the /install and cores pages) or "uninstall" (the removal page):
  // the two share the OS -> command flow; uninstall swaps the command builders,
  // drops the install-only options for a keep-data toggle, and has no installer
  // download. Mode defaults to install so those pages need no prop.
  let { target, mode = "install" }: { target: Target; mode?: "install" | "uninstall" } = $props();
  const verb = $derived(mode === "install" ? "Install" : "Uninstall");

  let os = $state<Os>("macos");
  // Stable has not shipped yet, so the channel is locked to latest; the picker
  // shows stable as a disabled option for when it does.
  const channel: Channel = "latest";
  let bindAll = $state(false);
  let service = $state(true);
  let behindProxy = $state(false);
  // Uninstall option, folded into the command like the core install toggles. It
  // reads as one axis ("keep my data"): on keeps, off deletes. Removing the
  // Client keeps its settings by default (on); removing the Core takes its data
  // by default (off).
  let keepData = $state(untrack(() => target === "client"));
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const detected = detectOs(navigator.userAgent, navigator.platform);
    // The Core has no Android build; fall back to a desktop OS for its picker.
    os = target === "core" && detected === "android" ? "linux" : detected;
  });

  const osChoices = $derived(target === "client" ? CLIENT_OS : CORE_OS);
  const isAndroid = $derived(target === "client" && os === "android");

  const command = $derived(
    mode === "uninstall"
      ? target === "client"
        ? clientUninstallCommand(os, channel, { purge: !keepData })
        : coreUninstallCommand(os, channel, { keepData })
      : target === "client"
        ? clientCommand(os, channel)
        : coreCommand(os, channel, { bindAll, service, behindProxy }),
  );

  // Native double-click installers for the current OS (the alternative to the
  // terminal command). Empty on Android, where the APK block handles it.
  const installers = $derived(nativeInstallers(target, os, channel));
  // Linux offers both .deb and .rpm, so its buttons need the format spelled out;
  // macOS/Windows are a single file, where the arch label alone is enough.
  const multiFormat = $derived(new Set(installers.map((i) => i.format)).size > 1);
  // The nested "how to": the two entry points are the (a, b) branches under step
  // one; their shared finishing steps are lifted to the top level (step 2+).
  // Uninstall has only the terminal path, so it renders a single flat list.
  const scriptSteps = $derived(scriptHowto(os));
  const installerSteps = $derived(installerHowto(os, target));
  const finishSteps = $derived(finishHowto(target));
  const uninstallSteps = $derived([openTerminalStep(os), ...uninstallStepsTail(target)]);

  function installerLabel(inst: NativeInstaller): string {
    return multiFormat ? `${inst.archLabel} · .${inst.format}` : inst.archLabel;
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

<!-- not-prose: this island mounts inside the manual's `.prose` (the cores and
     uninstall pages), whose presetTypography would otherwise restyle the command
     `<code>` (backtick quotes, code padding) and the list `<p>` margins. It is a
     no-op on the /install page, which has no prose ancestor. -->
<div class="not-prose flex flex-col gap-6">
  <!-- Operating system. -->
  <div class="flex flex-col gap-2">
    <span class={labelCls}>Operating System</span>
    <div class={`grid gap-2 ${target === "client" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
      {#each osChoices as o (o.id)}
        <button
          type="button"
          class={`${os === o.id ? btnActive : btnIdle} hover:cursor-pointer`}
          aria-pressed={os === o.id}
          onclick={() => (os = o.id)}
        >
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
      <button
        type="button"
        class={`${btnBase} bg-surface-inset text-default-500 opacity-60 cursor-not-allowed`}
        disabled
        aria-disabled="true"
      >
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
            <Toggle
              checked={bindAll}
              onchange={(v) => (bindAll = v)}
              ariaLabel="Allow access from other machines"
            />
          </div>
        </label>
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-default-700">Run in the background at login</span>
          <div class="w-24 shrink-0">
            <Toggle
              checked={service}
              onchange={(v) => (service = v)}
              ariaLabel="Run in the background at login"
            />
          </div>
        </label>
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-default-700">Served through an HTTPS proxy</span>
          <div class="w-24 shrink-0">
            <Toggle
              checked={behindProxy}
              onchange={(v) => (behindProxy = v)}
              ariaLabel="Served through an HTTPS proxy"
            />
          </div>
        </label>
      </div>
    </div>
  {/if}

  <!-- Uninstall option, folded into the command live like the install ones. One
       "keep my data" axis: on keeps, off deletes. -->
  {#if mode === "uninstall" && !isAndroid}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Options</span>
      <div class="flex flex-col gap-3 rounded-large bg-surface-inset px-4 py-3">
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-default-700">
            {target === "client" ? "Keep settings and paired cores" : "Keep sessions and memories"}
          </span>
          <div class="w-24 shrink-0">
            <Toggle
              checked={keepData}
              onchange={(v) => (keepData = v)}
              ariaLabel={target === "client"
                ? "Keep settings and paired cores"
                : "Keep sessions and memories"}
            />
          </div>
        </label>
      </div>
    </div>
  {/if}

  <!-- The command (or, for Android, the APK download / removal note). -->
  {#if isAndroid && mode === "uninstall"}
    <div class="flex flex-col gap-2">
      <span class={labelCls}>Remove</span>
      <div class="flex flex-col gap-3 rounded-large bg-surface-inset px-4 py-3">
        <p class="text-sm text-default-700 m-0">
          There is no script on Android. Remove tomat like any other app.
        </p>
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
        <p class="text-sm text-default-700 m-0">
          The Android app is a signed APK you install directly.
        </p>
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
    <!-- Terminal command: the copy-on-click card. -->
    <div class="flex flex-col gap-2">
      <span class={labelCls}>{verb} via terminal</span>
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
        <code
          class="font-mono text-sm text-default-800 overflow-x-auto whitespace-nowrap flex-1 no-scrollbar"
          >{command}</code
        >
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

    {#if mode === "install"}
      <!-- Or download the installer: the conventional double-click packages, one
           button per arch x format, styled like the OS / channel picker. -->
      <div class="flex flex-col gap-2">
        <span class={labelCls}>Or download the installer</span>
        <div class="grid grid-cols-2 gap-2">
          {#each installers as inst (inst.url)}
            <a href={inst.url} class={`${btnIdle} hover:cursor-pointer`}>
              <i class="i-material-symbols-download-rounded text-lg"></i>
              {installerLabel(inst)}
            </a>
          {/each}
        </div>
      </div>

      <!-- How to Install: a nested outline. The two entry points are the (a, b)
           branches under step one, each with its own numbered steps; the macOS
           Gatekeeper and Windows warnings are folded into the installer branch
           per OS by installerHowto. The uninstall pointer is the last step, not
           a footer. -->
      <div class="flex flex-col gap-2">
        <span class={labelCls}>How to Install</span>
        <ol class="m-0 flex flex-col gap-2 text-sm text-default-700 list-decimal pl-5">
          <li>
            Install with either path:
            <!-- lower-alpha inline: the Uno list utilities are prose-gated, so
                 they no-op inside this not-prose island; decimal/disc emit an
                 ungated rule, but lower-alpha only comes from prose, so it needs
                 an inline list-style-type to render the a./b. markers here. -->
            <ol class="mt-1.5 flex flex-col gap-1.5 pl-5" style="list-style-type: lower-alpha">
              <li>
                <span class="font-semibold text-default-800">Using the install script:</span>
                <ol class="mt-1 flex flex-col gap-1 list-decimal pl-5">
                  {#each scriptSteps as step (step)}
                    <li>{step}</li>
                  {/each}
                </ol>
              </li>
              <li>
                <span class="font-semibold text-default-800">Or download the installer:</span>
                <ol class="mt-1 flex flex-col gap-1 list-decimal pl-5">
                  {#each installerSteps as step, i (i)}
                    {#if typeof step === "string"}
                      <li>{step}</li>
                    {:else}
                      <li>
                        {step.text}
                        {#if step.sub.length}
                          <ul class="mt-1 flex flex-col gap-1 list-disc pl-5">
                            {#each step.sub as s (s)}
                              <li>{s}</li>
                            {/each}
                          </ul>
                        {/if}
                      </li>
                    {/if}
                  {/each}
                </ol>
              </li>
            </ol>
          </li>
          {#if target === "client"}
            <li>
              When it finishes, launch tomat and pick where the Core should run: on the same
              computer or <a href="/manual/maintenance/cores" class="underline hov:text-default-700"
                >on a different one</a
              >.
            </li>
          {/if}
          {#each finishSteps as step (step)}
            <li>{step}</li>
          {/each}
          <li>
            If you ever need to uninstall, follow <a
              href="/manual/maintenance/uninstalling"
              class="underline hov:text-default-700">the uninstallation guide</a
            >.
          </li>
        </ol>
      </div>
    {:else}
      <!-- Uninstall: the terminal-only steps (open a terminal, run the command). -->
      <div class="flex flex-col gap-2">
        <span class={labelCls}>How to Uninstall</span>
        <ol class="m-0 flex flex-col gap-2 text-sm text-default-700 list-decimal pl-5">
          {#each uninstallSteps as step (step)}
            <li>{step}</li>
          {/each}
        </ol>
      </div>
    {/if}
  {/if}
</div>
