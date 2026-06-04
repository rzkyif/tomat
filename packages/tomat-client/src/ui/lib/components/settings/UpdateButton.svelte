<script lang="ts">
  // Bottom-left of the Settings sidebar. Shows the client version and drives
  // the combined client + core + sidecar update flow.
  //
  // State machine:
  //   idle                 : "Tomat Client vX.X.X" / hover "Check for Updates"
  //   checking             : "Checking…"
  //   available            : "Updates Available!" / hover "Install Updates"
  //   updating             : "Updating…"
  //   clientRestartPending : "Restart to Update" (relaunches Tauri)

  import { onMount } from "svelte";
  import { platform, type UpdateHandle } from "$lib/platform";
  import { cores } from "$lib/core";
  import { confirmState, downloadsState } from "$lib/state";
  import type { BinaryKind, BinaryUpdateCheck } from "@tomat/shared";
  import CollapsibleLabel from "../ui/CollapsibleLabel.svelte";
  import { useBlink } from "$lib/composables/use-blink.svelte";
  import { getLogger } from "$lib/shared/log";

  const log = getLogger("update");

  let { collapsed, disabled = false } = $props<{
    collapsed: boolean;
    disabled?: boolean;
  }>();

  type Phase =
    | "idle"
    | "checking"
    | "available"
    | "updating"
    | "clientRestartPending";

  let phase = $state<Phase>("idle");
  let hovering = $state(false);
  let clientVersion = $state<string>("…");
  let coreAvailable = $state(false);
  let coreCurrent = $state<string>("");
  let coreLatest = $state<string>("");
  let binariesAvailable = $state<BinaryUpdateCheck[]>([]);
  let clientUpdate = $state<UpdateHandle | null>(null);

  onMount(async () => {
    try {
      clientVersion = await platform().updater.getVersion();
    } catch {
      clientVersion = "unknown";
    }
  });

  const label = $derived.by<string>(() => {
    switch (phase) {
      case "checking":
        return "Checking…";
      case "available":
        return hovering ? "Install Updates" : "Updates Available";
      case "updating":
        return "Updating…";
      case "clientRestartPending":
        return "Restart to Update";
      default:
        return hovering ? "Check for Updates" : `Tomat Client v${clientVersion}`;
    }
  });

  /** State-driven icon. Idle/available states render the tomat SVG (matches
   *  the spec's "tomat icon" affordance); transient states use unocss
   *  icon classes for the loading / restart glyphs. */
  type IconMode =
    | { kind: "tomat" }
    | { kind: "class"; className: string };

  const icon = $derived.by<IconMode>(() => {
    switch (phase) {
      case "checking":
      case "updating":
        return { kind: "class", className: "i-line-md:loading-loop" };
      case "clientRestartPending":
        return {
          kind: "class",
          className: "i-material-symbols-restart-alt-rounded",
        };
      default:
        return { kind: "tomat" };
    }
  });

  // Pulse between two yellow shades while an update is available: a same-hue
  // attention ping. Interval matches the button's 500ms color transition so the
  // color is always mid-tween (no flat hold). See useBlink.
  const updateBlink = useBlink();
  $effect(() => updateBlink.run(phase === "available"));

  // Lives on the button so the icon (currentColor) and label inherit it and the
  // button's 500ms color transition tweens the whole row together.
  const tone = $derived.by<string>(() => {
    if (phase === "available") {
      return updateBlink.on
        ? "text-accent-yellow-700"
        : "text-accent-yellow-500";
    }
    return "text-default-500 hover:text-default-700";
  });

  async function onClick() {
    if (phase === "checking" || phase === "updating") return;
    if (phase === "clientRestartPending") {
      try {
        await platform().updater.relaunch();
      } catch (e) {
        log.warn("relaunch failed:", e);
      }
      return;
    }
    if (phase === "available") {
      await confirmInstall();
      return;
    }
    await runCheck();
  }

  async function runCheck() {
    phase = "checking";
    coreAvailable = false;
    binariesAvailable = [];
    clientUpdate = null;

    const tasks: Promise<void>[] = [];

    // Core self-update.
    tasks.push(
      (async () => {
        try {
          const res = await cores().api().update.check();
          coreAvailable = res.available;
          coreCurrent = res.currentVersion;
          coreLatest = res.latestVersion;
        } catch (e) {
          log.warn("core check failed:", e);
        }
      })(),
    );

    // Sidecar binaries.
    tasks.push(
      (async () => {
        try {
          const res = await cores().api().binaries.check();
          binariesAvailable = res.filter((b) => b.available);
        } catch (e) {
          log.warn("binaries check failed:", e);
        }
      })(),
    );

    // Client (Tauri).
    tasks.push(
      (async () => {
        try {
          clientUpdate = await platform().updater.check();
        } catch (e) {
          log.warn("client check failed:", e);
        }
      })(),
    );

    await Promise.allSettled(tasks);

    const anyAvailable = coreAvailable || binariesAvailable.length > 0 ||
      !!clientUpdate;
    phase = anyAvailable ? "available" : "idle";
  }

  async function confirmInstall() {
    const lines: string[] = [];
    if (clientUpdate) {
      lines.push(`Tomat Client v${clientUpdate.version} (client)`);
    }
    if (coreAvailable) {
      lines.push(`Tomat Core v${coreLatest} (core, currently v${coreCurrent})`);
    }
    for (const b of binariesAvailable) {
      lines.push(
        `${b.kind} v${b.latestVersion}` +
          (b.installedVersion ? ` (was v${b.installedVersion})` : ""),
      );
    }
    confirmState.request({
      title: "Install updates",
      message:
        `The following components will be updated. Core and sidecars will be ` +
        `downloaded; the client will need a restart at the end.\n\n` +
        lines.map((l) => `• ${l}`).join("\n"),
      confirmLabel: "Install",
      onConfirm: () => void runInstall(),
    });
  }

  async function runInstall() {
    phase = "updating";

    const binaryKinds: BinaryKind[] = binariesAvailable.map((b) => b.kind);

    try {
      // Kick off sidecar binary updates first. These are short and let the
      // user see progress in the downloads modal while the bigger work runs.
      for (const kind of binaryKinds) {
        try {
          await cores().api().binaries.update(kind);
        } catch (e) {
          log.warn(`binary update ${kind} failed:`, e);
        }
      }

      // Core self-update. The HTTP request typically does NOT return cleanly.
      // The core exits during apply() to hand off to the updater binary.
      // The next /health probe (or the WS reconnect logic) will see the new
      // version. Swallow the request-aborted error.
      if (coreAvailable) {
        try {
          await cores().api().update.apply();
        } catch (e) {
          log.warn("core.apply error (expected during handoff):", e);
        }
      }

      // Client artifact. tauri-plugin-updater downloads the bundle, verifies
      // the signature, and stages it for the next launch. Restart is in the
      // user's hands so they don't lose unsaved input.
      if (clientUpdate) {
        try {
          await clientUpdate.downloadAndInstall();
          phase = "clientRestartPending";
          return;
        } catch (e) {
          log.warn("client downloadAndInstall failed:", e);
        }
      }

      phase = "idle";
    } catch (e) {
      log.warn("install failed:", e);
      phase = "idle";
    }
  }
</script>

<!-- Custom row (not SidebarItem) because the idle "tomat icon" needs the
     existing SVG-mask approach rather than a unocss icon class. Geometry
     mirrors SidebarItem so the row aligns with the rest of the column. -->
<button
  type="button"
  class="hover:cursor-pointer flex items-center h-8 pl-1.5 {collapsed
    ? 'pr-0'
    : 'pr-2.5'} gap-1.5 rounded-medium [transition:color_500ms,background-color_200ms,padding_200ms] disabled:opacity-50 disabled:pointer-events-none {tone} hover:bg-surface-inset"
  title={collapsed ? label : undefined}
  aria-label={label}
  {disabled}
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => (hovering = false)}
  onfocus={() => (hovering = true)}
  onblur={() => (hovering = false)}
  onclick={onClick}
>
  <span class="relative flex shrink-0">
    {#if icon.kind === "tomat"}
      <span
        class="w-5 h-5 bg-current shrink-0"
        style="mask:url(/tomat.svg) center/contain no-repeat;-webkit-mask:url(/tomat.svg) center/contain no-repeat;"
        aria-hidden="true"
      ></span>
    {:else}
      <i class="flex text-xl shrink-0 {icon.className}"></i>
    {/if}
  </span>
  <CollapsibleLabel {collapsed} class="text-base text-left">
    {label}
  </CollapsibleLabel>
</button>
