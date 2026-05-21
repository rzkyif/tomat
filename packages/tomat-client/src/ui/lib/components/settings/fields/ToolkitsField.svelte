<script lang="ts">
  import { onMount } from "svelte";
  import {
    type Grant,
    permissionKey,
    type SettingField,
    type Tool,
    type Toolkit,
  } from "@tomat/shared";
  import { confirmState, toolkitsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let { field } = $props<{ field: SettingField }>();

  let busyId = $state<string | null>(null);
  let searchQuery = $state("");
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  /** Toolkits whose tool list is currently expanded in the UI. */
  let expandedToolkits = $state<Set<string>>(new Set());
  /** Tools whose permission grant list is currently expanded. Keyed by
   *  `${toolkitId}::${toolName}` so it's stable across re-renders. */
  let expandedTools = $state<Set<string>>(new Set());

  onMount(() => {
    void (async () => {
      try {
        await toolkitsState.refresh();
      } catch (err) {
        reportError("Load toolkits", err);
      }
    })();
  });

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

  // --- search / install -------------------------------------------------

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function handleSearchInput(value: string) {
    searchQuery = value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      void runSearch();
    }, 250);
  }

  async function runSearch() {
    searchError = null;
    searching = true;
    try {
      await toolkitsState.search(searchQuery);
    } catch (err) {
      searchError = err instanceof Error ? err.message : String(err);
    } finally {
      searching = false;
    }
  }

  async function handleInstall(name: string) {
    await runAction(`install:${name}`, "Install", async () => {
      await toolkitsState.install({ source: "npm", name });
    });
  }

  // --- toolkit lifecycle -------------------------------------------------

  function confirmUninstall(tk: Toolkit) {
    confirmState.request({
      title: "Uninstall toolkit",
      message:
        `Remove "${tk.displayName || tk.id}" v${tk.version}? Its grants and installed files will be deleted.`,
      destructive: true,
      confirmLabel: "Uninstall",
      onConfirm: () =>
        runAction(tk.id, "Uninstall", () => toolkitsState.uninstall(tk.id)),
    });
  }

  async function handleToggleToolkit(tk: Toolkit) {
    await runAction(tk.id, tk.enabled ? "Disable" : "Enable", async () => {
      if (tk.enabled) await toolkitsState.disableToolkit(tk.id);
      else await toolkitsState.enableToolkit(tk.id);
    });
  }

  async function handleToggleTool(toolkitId: string, tool: Tool) {
    const action = tool.enabled ? "Disable tool" : "Enable tool";
    await runAction(`${toolkitId}::${tool.name}`, action, async () => {
      if (tool.enabled) {
        await toolkitsState.disableTool(toolkitId, tool.name);
      } else {
        await toolkitsState.enableTool(toolkitId, tool.name);
      }
    });
  }

  async function handleExpandToolkit(tk: Toolkit) {
    const next = new Set(expandedToolkits);
    if (next.has(tk.id)) {
      next.delete(tk.id);
    } else {
      next.add(tk.id);
      // Lazy-load tools on first expand if they aren't embedded yet.
      if (!tk.tools) {
        try {
          await toolkitsState.loadTools(tk.id);
        } catch (err) {
          reportError("Load tools", err);
        }
      }
    }
    expandedToolkits = next;
  }

  function toggleExpandTool(toolkitId: string, toolName: string) {
    const key = `${toolkitId}::${toolName}`;
    const next = new Set(expandedTools);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedTools = next;
  }

  // --- grants -----------------------------------------------------------

  /** Resolve the current state of a permission for a tool. Defaults to
   *  "ungranted" when no grant row exists yet. */
  function grantStateFor(tool: Tool, key: string): "granted" | "denied" | "ungranted" {
    const g = tool.grants.find((g: Grant) => g.permissionKey === key);
    return g ? g.state : "ungranted";
  }

  /** Apply a single-permission change. Send the full grants array for the
   *  tool back to the server so the patch is order-independent. */
  async function handleGrantChange(
    toolkitId: string,
    tool: Tool,
    permKey: string,
    nextState: "granted" | "denied",
  ) {
    // Build the next grants array: keep all existing grants except the one
    // we're touching, then append the new state.
    const merged: Array<{ key: string; state: Grant["state"] }> = [];
    for (const g of tool.grants) {
      if (g.permissionKey !== permKey) {
        merged.push({ key: g.permissionKey, state: g.state });
      }
    }
    merged.push({ key: permKey, state: nextState });
    await runAction(
      `${toolkitId}::${tool.name}::${permKey}`,
      "Update grant",
      () => toolkitsState.setGrants(toolkitId, tool.name, merged),
    );
  }

  /** Human-readable summary of a permission decl, e.g. "net api.openai.com:443"
   *  or "read /etc/hosts". Kept short so it fits in a settings row. */
  function permissionSummary(decl: Tool["requiredPermissions"][number]): string {
    switch (decl.kind) {
      case "net":
        return `net ${decl.host}:${decl.ports.map(String).join(",")}`;
      case "read":
        return `read ${decl.path}`;
      case "write":
        return `write ${decl.path}`;
      case "run":
        return `run ${decl.binary}`;
      case "env":
        return `env ${decl.key}`;
      case "ffi":
        return `ffi`;
      case "sys":
        return `sys ${decl.flag}`;
    }
  }

  function toolkitStatus(tk: Toolkit): { label: string; color: string } {
    if (tk.lastError) {
      return { label: "Error", color: "text-red-600 dark:text-red-400" };
    }
    if (tk.enabled) {
      return { label: "Enabled", color: "text-green-500" };
    }
    return { label: "Disabled", color: "text-default-600" };
  }

  let runningJobs = $derived(
    Object.values(toolkitsState.installJobs).filter(
      (j) => j.status === "running",
    ),
  );
</script>

<FieldCard {field}>
  <div class="flex flex-col gap-3">
    <!-- Search bar -->
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <div class="relative flex-1">
          <i
            class="i-material-symbols-search-rounded absolute left-2 top-1/2 -translate-y-1/2 text-default-600 pointer-events-none"
          ></i>
          <input
            type="text"
            aria-label="Search npm for toolkits"
            placeholder="Search npm for toolkits..."
            class="bg-default-300 text-default-800 rounded-medium block w-full h-8 pl-7 pr-2 outline-none"
            value={searchQuery}
            oninput={(e) =>
              handleSearchInput((e.target as HTMLInputElement).value)}
          />
        </div>
        {#if searching}
          <i
            class="i-material-symbols-progress-activity animate-spin text-default-600 text-lg"
          ></i>
        {/if}
      </div>
      {#if searchError}
        <div class="text-red-500 text-sm">{searchError}</div>
      {/if}
    </div>

    <!-- Search results -->
    {#if toolkitsState.searchResults.length > 0}
      <div class="flex flex-col gap-2">
        <div class="text-default-600 text-sm">Search results</div>
        {#each toolkitsState.searchResults as result (result.name)}
          {@const alreadyInstalled = toolkitsState.installed.some(
            (t) => t.id === result.name || t.id === result.name.replace("/", "__"),
          )}
          <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
            <div class="flex flex-col gap-0.5">
              <div class="font-medium text-default-800 break-words">
                {result.name}
                <span class="text-xs text-default-600 font-normal"
                  >v{result.version}</span
                >
              </div>
              {#if result.description}
                <div class="text-sm text-default-700 break-words">
                  {result.description}
                </div>
              {/if}
              {#if result.weeklyDownloads !== undefined}
                <div class="text-xs text-default-600">
                  {result.weeklyDownloads.toLocaleString()} weekly downloads
                </div>
              {/if}
            </div>
            <button
              type="button"
              class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
              disabled={alreadyInstalled || busyId === `install:${result.name}`}
              onclick={() => handleInstall(result.name)}
            >
              {#if alreadyInstalled}
                Installed
              {:else if busyId === `install:${result.name}`}
                Starting install...
              {:else}
                Install
              {/if}
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Running install jobs -->
    {#if runningJobs.length > 0}
      <div class="flex flex-col gap-2">
        <div class="text-default-600 text-sm">Installing</div>
        {#each runningJobs as job (job.id)}
          <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
            <div class="flex flex-col gap-0.5">
              <div class="font-medium text-default-800 break-words">
                {job.label}
              </div>
              <div class="text-xs text-amber-500">Installing…</div>
            </div>
            <details class="text-xs" open>
              <summary class="cursor-pointer text-default-600"
                >Install output</summary
              >
              <pre
                class="text-default-700 bg-default-400 rounded-small px-2 py-1 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{job.lines
                  .map((l) => l.line)
                  .join("\n")}</pre>
            </details>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Installed toolkits -->
    {#if toolkitsState.installed.length > 0}
      <div class="flex flex-col gap-2">
        <div class="text-default-600 text-sm">Installed</div>
        {#each toolkitsState.installed as tk (tk.id)}
          {@const status = toolkitStatus(tk)}
          {@const expanded = expandedToolkits.has(tk.id)}
          <div class="flex flex-col gap-2 p-3 bg-default-300 rounded-large">
            <div class="flex flex-col gap-0.5">
              <div class="font-medium text-default-800 break-words">
                {tk.displayName || tk.id}
                <span class="text-xs text-default-600 font-normal"
                  >v{tk.version}</span
                >
              </div>
              <div class="text-xs {status.color}">{status.label}</div>
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
            <div class="flex flex-col gap-1.5">
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-default-500 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => handleExpandToolkit(tk)}
              >
                {expanded ? "Hide tools" : "Show tools"}
                {#if tk.tools}
                  <span class="text-xs text-default-600">({tk.tools.length})</span>
                {/if}
              </button>
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => handleToggleToolkit(tk)}
              >
                {tk.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                class="w-full text-sm px-3 py-1.5 rounded bg-default-400 text-default-800 hover:bg-red-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-400 disabled:hover:text-default-800"
                disabled={busyId === tk.id}
                onclick={() => confirmUninstall(tk)}
              >
                Uninstall
              </button>
            </div>

            <!-- Per-tool list -->
            {#if expanded && tk.tools}
              <div class="flex flex-col gap-2 pt-1">
                {#if tk.tools.length === 0}
                  <div class="text-sm text-default-600 italic">
                    No tools declared.
                  </div>
                {/if}
                {#each tk.tools as tool (tool.id)}
                  {@const toolKey = `${tk.id}::${tool.name}`}
                  {@const toolExpanded = expandedTools.has(toolKey)}
                  {@const missing = tool.missingRequired.length}
                  <div
                    class="flex flex-col gap-2 p-2 bg-default-400 rounded-medium"
                  >
                    <div class="flex flex-col gap-0.5">
                      <span class="font-mono text-sm text-default-800 break-all"
                        >{tool.name}</span
                      >
                      {#if tool.description}
                        <span class="text-xs text-default-700 break-words"
                          >{tool.description}</span
                        >
                      {/if}
                      {#if missing > 0}
                        <span class="text-xs text-amber-500"
                          >Needs {missing} permission grant{missing > 1
                            ? "s"
                            : ""} before it can be enabled</span
                        >
                      {/if}
                    </div>
                    <div class="flex flex-col gap-1">
                      {#if tool.requiredPermissions.length > 0}
                        <button
                          type="button"
                          class="w-full text-xs px-2 py-1 rounded bg-default-300 text-default-800 hover:bg-default-500 transition-colors cursor-pointer"
                          onclick={() => toggleExpandTool(tk.id, tool.name)}
                        >
                          {toolExpanded ? "Hide" : "Show"} permissions ({tool
                            .requiredPermissions.length})
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="w-full text-xs px-2 py-1 rounded bg-default-300 text-default-800 hover:bg-green-600 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-default-300 disabled:hover:text-default-800"
                        disabled={busyId === toolKey ||
                          (!tool.enabled && missing > 0)}
                        title={!tool.enabled && missing > 0
                          ? "Grant all required permissions first"
                          : ""}
                        onclick={() => handleToggleTool(tk.id, tool)}
                      >
                        {tool.enabled ? "Disable tool" : "Enable tool"}
                      </button>
                    </div>

                    <!-- Permission grant rows -->
                    {#if toolExpanded}
                      <div class="flex flex-col gap-1">
                        {#each tool.requiredPermissions as decl (permissionKey(decl))}
                          {@const key = permissionKey(decl)}
                          {@const state = grantStateFor(tool, key)}
                          <div
                            class="flex flex-col gap-1 p-2 bg-default-300 rounded-small"
                          >
                            <div class="flex flex-col gap-0.5">
                              <span
                                class="font-mono text-xs text-default-800 break-all"
                                >{permissionSummary(decl)}</span
                              >
                              <span
                                class="text-xs text-default-700 break-words"
                                >{decl.reason}</span
                              >
                              {#if decl.optional}
                                <span class="text-xs text-default-600 italic"
                                  >optional</span
                                >
                              {/if}
                            </div>
                            <div class="flex items-center gap-3 text-xs">
                              <label
                                class="flex items-center gap-1 cursor-pointer"
                              >
                                <input
                                  type="radio"
                                  name={`${toolKey}::${key}`}
                                  checked={state === "granted"}
                                  disabled={busyId ===
                                    `${tk.id}::${tool.name}::${key}`}
                                  onchange={() =>
                                    handleGrantChange(
                                      tk.id,
                                      tool,
                                      key,
                                      "granted",
                                    )}
                                />
                                <span class="text-default-800">Grant</span>
                              </label>
                              <label
                                class="flex items-center gap-1 cursor-pointer"
                              >
                                <input
                                  type="radio"
                                  name={`${toolKey}::${key}`}
                                  checked={state === "denied"}
                                  disabled={busyId ===
                                    `${tk.id}::${tool.name}::${key}`}
                                  onchange={() =>
                                    handleGrantChange(
                                      tk.id,
                                      tool,
                                      key,
                                      "denied",
                                    )}
                                />
                                <span class="text-default-800">Deny</span>
                              </label>
                              {#if state === "ungranted"}
                                <span class="text-amber-500">Unset</span>
                              {/if}
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if toolkitsState.installed.length === 0 &&
      toolkitsState.searchResults.length === 0 &&
      runningJobs.length === 0}
      <div class="text-sm text-default-600 italic">
        No toolkits installed yet. Search npm above and click Install to add
        one.
      </div>
    {/if}
  </div>
</FieldCard>
