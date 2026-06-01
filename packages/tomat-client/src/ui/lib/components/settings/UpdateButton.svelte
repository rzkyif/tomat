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

  let { collapsed } = $props<{ collapsed: boolean }>();

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
        return hovering ? "Install Updates" : "Updates Available!";
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

  const tone = $derived.by<string>(() => {
    if (phase === "available") return "text-accent-orange-300";
    return "text-default-700";
  });

  async function onClick() {
    if (phase === "checking" || phase === "updating") return;
    if (phase === "clientRestartPending") {
      try {
        await platform().updater.relaunch();
      } catch (e) {
        console.warn("[update] relaunch failed:", e);
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
          console.warn("[update] core check failed:", e);
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
          console.warn("[update] binaries check failed:", e);
        }
      })(),
    );

    // Client (Tauri).
    tasks.push(
      (async () => {
        try {
          clientUpdate = await platform().updater.check();
        } catch (e) {
          console.warn("[update] client check failed:", e);
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
          console.warn(`[update] binary update ${kind} failed:`, e);
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
          console.warn(
            "[update] core.apply error (expected during handoff):",
            e,
          );
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
          console.warn("[update] client downloadAndInstall failed:", e);
        }
      }

      phase = "idle";
    } catch (e) {
      console.warn("[update] install failed:", e);
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
    : 'pr-2.5'} gap-1.5 rounded-medium transition-[padding,colors,background-color] duration-200 text-default-500 hover:text-default-700 hover:bg-default-200"
  title={collapsed ? label : undefined}
  aria-label={label}
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => (hovering = false)}
  onfocus={() => (hovering = true)}
  onblur={() => (hovering = false)}
  onclick={onClick}
>
  <span class="relative flex shrink-0">
    {#if icon.kind === "tomat"}
      <span
        class="w-5 h-5 bg-current shrink-0 {tone}"
        style="mask:url(/tomat.svg) center/contain no-repeat;-webkit-mask:url(/tomat.svg) center/contain no-repeat;"
        aria-hidden="true"
      ></span>
    {:else}
      <i class="flex text-xl shrink-0 {icon.className} {tone}"></i>
    {/if}
    {#if phase === "available"}
      <!-- Small accent dot signaling "something to act on". It pairs with
           the orange label below so the cue is visible even with the
           label collapsed. -->
      <span
        class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-orange-300 pointer-events-none"
        aria-hidden="true"
      ></span>
    {/if}
  </span>
  <CollapsibleLabel {collapsed} class="text-base text-left">
    {label}
  </CollapsibleLabel>
</button>
