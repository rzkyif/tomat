<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { SettingField } from "$lib/shared/settings";
  import { confirmState, toolkitsState, type ToolkitRow } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let { field } = $props<{ field: SettingField }>();

  let busyId = $state<string | null>(null);

  onMount(() => {
    void toolkitsState.ensureConnected();
    void (async () => {
      try {
        await toolkitsState.refresh();
        await toolkitsState.refreshMissingMetadata();
      } catch (err) {
        reportError("Load toolkits", err);
      }
    })();
  });

  let enabledToolkits = $derived(
    toolkitsState.trusted.filter((t) => t.enabled),
  );
  let disabledTrustedToolkits = $derived(
    toolkitsState.trusted.filter((t) => !t.enabled),
  );

  function reportError(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[toolkits] ${action} failed:`, err);
    confirmState.alert({ title: `${action} failed`, message });
  }

  async function runAction<T>(
    id: string,
    action: string,
    fn: () => Promise<T>,
  ): Promise<void> {
    busyId = id;
    try {
      await fn();
    } catch (err) {
      reportError(action, err);
    } finally {
      busyId = null;
    }
  }

  async function handleRefresh() {
    try {
      await toolkitsState.refresh();
    } catch (err) {
      reportError("Refresh", err);
    }
  }

  async function handleOpenFolder() {
    try {
      await invoke("open_toolkits_folder");
    } catch (err) {
      reportError("Open folder", err);
    }
  }

  function confirmTrust(id: string, hasPackage: boolean) {
    const lines = [
      "Trusting a toolkit lets its code run inside the sidecar when its tools are invoked by the agent.",
      "Only trust toolkits whose source you have reviewed.",
    ];
    if (hasPackage) {
      lines.push(
        "This toolkit has a package.json. Install Dependencies will run `bun install`, which may execute dependency setup code.",
      );
    }
    confirmState.request({
      title: "Trust toolkit",
      message: `${lines.join("\n\n")}\n\nTrust "${id}"?`,
      confirmLabel: "Trust",
      onConfirm: () => runAction(id, "Trust", () => toolkitsState.trust(id)),
    });
  }

  function confirmUntrust(id: string) {
    confirmState.request({
      title: "Untrust toolkit",
      message: `Untrusting "${id}" removes its cached metadata. The source files on disk are kept.`,
      destructive: true,
      confirmLabel: "Untrust",
      onConfirm: () =>
        runAction(id, "Untrust", () => toolkitsState.untrust(id)),
    });
  }

  function confirmUninstallDeps(id: string) {
    confirmState.request({
      title: "Uninstall dependencies",
      message: `Delete node_modules/ and bun.lock for "${id}".`,
      destructive: true,
      confirmLabel: "Uninstall",
      onConfirm: () =>
        runAction(id, "Uninstall dependencies", () =>
          toolkitsState.uninstallDeps(id),
        ),
    });
  }

  async function handleInstall(id: string) {
    await runAction(id, "Install dependencies", () =>
      toolkitsState.install(id),
    );
  }

  async function handleEnable(id: string) {
    await runAction(id, "Enable", () => toolkitsState.enable(id));
  }

  async function handleDisable(id: string) {
    await runAction(id, "Disable", () => toolkitsState.disable(id));
  }

  function statusBadge(tk: ToolkitRow): { label: string; color: string } {
    if (tk.lastError)
      return { label: "Error", color: "text-red-600 dark:text-red-400" };
    if (tk.enabled) {
      // "Enabled" means the toolkit's tools are reachable to the agent.
      // Until embeddings exist, phase-1 vector search returns nothing for
      // this toolkit, so calling it "Enabled" misleads the user. Surface
      // indexing progress instead.
      if (tk.tools.length === 0) {
        return { label: "Enabled (no tools)", color: "text-amber-500" };
      }
      if (tk.embeddedToolCount === 0) {
        return { label: "Indexing…", color: "text-amber-500" };
      }
      if (tk.embeddedToolCount < tk.tools.length) {
        return {
          label: `Indexing ${tk.embeddedToolCount}/${tk.tools.length}`,
          color: "text-amber-500",
        };
      }
      return { label: "Enabled", color: "text-green-500" };
    }
    if (tk.hasPackage && !tk.depsInstalled)
      return { label: "Needs install", color: "text-amber-500" };
    return { label: "Trusted", color: "text-default-600" };
  }

</script>

<FieldCard {field}>
  <div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="flex items-center gap-1 bg-default-300 hover:bg-default-400 text-default-800 rounded-large px-3 h-8 text-sm hover:cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none"
      onclick={handleOpenFolder}
      title="Open the toolkits folder in your file manager"
    >
      <i class="flex i-material-symbols-folder-open-rounded"></i>
      <span>Open Folder</span>
    </button>
    <button
      type="button"
      class="flex items-center gap-1 bg-default-300 hover:bg-default-400 text-default-800 rounded-large px-3 h-8 text-sm hover:cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none"
      onclick={handleRefresh}
      title="Rescan ~/.tomat/toolkits/"
    >
      <i class="flex i-material-symbols-refresh-rounded"></i>
      <span>Refresh</span>
    </button>
  </div>

  {#if enabledToolkits.length > 0}
    <div class="flex flex-col gap-2">
      <div class="text-default-600 text-sm">Enabled</div>
      {#each enabledToolkits as tk (tk.id)}
        <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
          <div class="flex flex-col gap-0.5">
            <div class="font-medium text-default-800 break-words">
              {tk.displayName || tk.id}
            </div>
            <div class="text-xs {statusBadge(tk).color}">
              {statusBadge(tk).label}
            </div>
          </div>
          {#if tk.description}
            <div class="text-sm text-default-700 break-words">
              {tk.description}
            </div>
          {/if}
          {#if tk.tools.length > 0}
            <div class="flex flex-col gap-0.5">
              {#each tk.tools as tool (tool.id)}
                <div class="text-xs text-default-700 flex flex-col">
                  <span class="font-mono text-default-800 break-all"
                    >{tool.name}</span
                  >
                  <span class="text-default-600 break-words"
                    >- {tool.description}</span
                  >
                </div>
              {/each}
            </div>
          {/if}
          {#if tk.lastError}
            <div class="text-xs text-red-600 dark:text-red-400 break-words">
              {tk.lastError}
            </div>
          {/if}
          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-red-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
              disabled={busyId === tk.id}
              onclick={() => handleDisable(tk.id)}
            >
              Disable
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if disabledTrustedToolkits.length > 0}
    <div class="flex flex-col gap-2">
      <div class="text-default-600 text-sm">Trusted</div>
      {#each disabledTrustedToolkits as tk (tk.id)}
        {@const needsInstall = tk.hasPackage && !tk.depsInstalled}
        {@const canUninstallDeps = tk.hasPackage && tk.depsInstalled}
        <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
          <div class="flex flex-col gap-0.5">
            <div class="font-medium text-default-800 break-words">
              {tk.displayName || tk.id}
            </div>
            <div class="text-xs {statusBadge(tk).color}">
              {statusBadge(tk).label}
            </div>
          </div>
          {#if tk.description}
            <div class="text-sm text-default-700 break-words">
              {tk.description}
            </div>
          {/if}
          {#if tk.lastError}
            <div class="text-xs text-red-600 dark:text-red-400 break-words">
              {tk.lastError}
            </div>
          {/if}
          {#if toolkitsState.installJobs[tk.id]}
            {@const job = toolkitsState.installJobs[tk.id]}
            <details class="text-xs" open={job.status === "running"}>
              <summary class="cursor-pointer text-default-600"
                >Install output ({job.status})</summary
              >
              <pre
                class="text-default-700 bg-default-400 rounded-small px-2 py-1 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{job.lines
                  .map((l) => l.line)
                  .join("\n")}</pre>
            </details>
          {/if}
          <div class="flex flex-col gap-1.5">
            {#if needsInstall}
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-red-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => confirmUntrust(tk.id)}
              >
                Untrust
              </button>
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id ||
                  toolkitsState.installJobs[tk.id]?.status === "running"}
                onclick={() => handleInstall(tk.id)}
              >
                {#if toolkitsState.installJobs[tk.id]?.status === "running"}
                  Installing...
                {:else}
                  Install Dependencies
                {/if}
              </button>
            {:else}
              {#if canUninstallDeps}
                <button
                  type="button"
                  class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-red-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                  disabled={busyId === tk.id}
                  onclick={() => confirmUninstallDeps(tk.id)}
                >
                  Uninstall Dependencies
                </button>
              {/if}
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-red-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => confirmUntrust(tk.id)}
              >
                Untrust
              </button>
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => handleEnable(tk.id)}
              >
                Enable
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if toolkitsState.untrusted.length > 0}
    <div class="flex flex-col gap-2">
      <div class="text-default-600 text-sm">Untrusted</div>
      {#each toolkitsState.untrusted as tk (tk.id)}
        <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
          <div class="flex flex-col gap-0.5">
            <div class="font-mono text-default-800 break-all">{tk.id}</div>
            <div class="text-xs text-default-600">
              {tk.kind === "folder" ? "folder" : "file"}{tk.hasPackage
                ? " • package.json"
                : ""}
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
              disabled={busyId === tk.id}
              onclick={() => confirmTrust(tk.id, tk.hasPackage)}
            >
              Trust
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if toolkitsState.trusted.length === 0 && toolkitsState.untrusted.length === 0}
    <div class="text-sm text-default-600 italic">
      No toolkits found. Drop a .ts file or a folder into ~/.tomat/toolkits/ and
      press Refresh.
    </div>
  {/if}
  </div>
</FieldCard>
