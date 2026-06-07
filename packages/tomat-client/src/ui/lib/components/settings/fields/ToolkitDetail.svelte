<script lang="ts">
  import { onMount } from "svelte";
  import { errMessage, type Grant, permissionKey, type Tool, type Toolkit } from "@tomat/shared";
  import { confirmState, toolkitsState } from "$lib/state";
  import Button from "$lib/components/ui/Button.svelte";

  let { toolkit }: { toolkit: Toolkit } = $props();

  let busyId = $state<string | null>(null);
  let bulkBusy = $state(false);
  let expandedTools = $state<Set<string>>(new Set());
  let toolsError = $state<string | null>(null);

  // A drifted toolkit had its tools disabled; block all toggling until the user
  // confirms re-enable (from the toolkit menu), which re-pins the content hash.
  const drifted = $derived(toolkit.status === "drift");

  onMount(() => {
    if (!toolkit.tools) void loadTools(toolkit.id);
  });

  async function loadTools(id: string) {
    try {
      await toolkitsState.loadTools(id);
    } catch (e) {
      toolsError = errMessage(e);
    }
  }

  async function runToolAction(id: string, fn: () => Promise<void>) {
    busyId = id;
    try {
      await fn();
    } catch (e) {
      confirmState.alert({ title: "Action failed", message: errMessage(e) });
    } finally {
      busyId = null;
    }
  }

  async function runBulk(fn: () => Promise<void>) {
    bulkBusy = true;
    try {
      await fn();
    } catch (e) {
      confirmState.alert({ title: "Action failed", message: errMessage(e) });
    } finally {
      bulkBusy = false;
    }
  }

  function toggleExpandTool(toolName: string) {
    const next = new Set(expandedTools);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    expandedTools = next;
  }

  function grantStateFor(tool: Tool, key: string): "granted" | "denied" | "ungranted" {
    return tool.grants.find((g) => g.permissionKey === key)?.state ?? "ungranted";
  }

  async function handleGrantChange(
    tool: Tool,
    permKey: string,
    nextState: "granted" | "denied",
  ) {
    const merged: Array<{ key: string; state: Grant["state"] }> = [];
    for (const g of tool.grants) {
      if (g.permissionKey !== permKey) merged.push({ key: g.permissionKey, state: g.state });
    }
    merged.push({ key: permKey, state: nextState });
    await runToolAction(
      `${tool.name}::${permKey}`,
      () => toolkitsState.setGrants(toolkit.id, tool.name, merged),
    );
  }

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
        return "ffi";
      case "sys":
        return `sys ${decl.flag}`;
    }
  }
</script>

<div class="flex flex-col gap-3">
  {#if toolkit.lastError}
    <div class="text-sm text-accent-red-600 break-words">{toolkit.lastError}</div>
  {/if}
  {#if toolsError}
    <div class="text-sm text-accent-red-600 break-words">{toolsError}</div>
  {/if}

  {#if drifted}
    <div class="flex flex-col gap-1 p-3 bg-surface-inset rounded-large">
      <span class="text-sm text-accent-red-600">Content changed since install</span>
      <span class="text-xs text-default-700 break-words">
        This toolkit's files changed on disk, so its tools were disabled. Review the change,
        then choose "Review &amp; re-enable" from the toolkit menu to trust the current contents.
      </span>
    </div>
  {/if}

  {#if !toolkit.tools}
    <div class="flex justify-center py-6 text-default-500">
      <i class="i-material-symbols-progress-activity animate-spin text-lg"></i>
    </div>
  {:else if toolkit.tools.length === 0}
    <div class="text-sm text-default-600 italic">No tools declared.</div>
  {:else}
    <div class="flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={bulkBusy || drifted}
        onclick={() => runBulk(() => toolkitsState.enableAllTools(toolkit.id))}
      >
        Enable all
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={bulkBusy || drifted}
        onclick={() => runBulk(() => toolkitsState.disableAllTools(toolkit.id))}
      >
        Disable all
      </Button>
    </div>
    <div class="flex flex-col gap-2">
      {#each toolkit.tools as tool (tool.id)}
        {@const expanded = expandedTools.has(tool.name)}
        {@const missing = tool.missingRequired.length}
        <div class="flex flex-col gap-2 p-3 bg-surface-inset rounded-large">
          <div class="flex items-start justify-between gap-2">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="font-mono text-sm text-default-800 break-all">{tool.name}</span>
              {#if tool.description}
                <span class="text-xs text-default-700 break-words">{tool.description}</span>
              {/if}
              {#if missing > 0}
                {#if tool.enabled}
                  <span class="text-xs text-accent-yellow-600">
                    Enabled, not exposed: needs {missing} permission grant{missing > 1 ? "s" : ""}
                  </span>
                {:else}
                  <span class="text-xs text-default-600">
                    Needs {missing} permission grant{missing > 1 ? "s" : ""} to be used by the assistant
                  </span>
                {/if}
              {/if}
            </div>
            <Button
              size="sm"
              variant={tool.enabled ? "secondary" : "primary"}
              disabled={busyId === tool.name || drifted}
              onclick={() =>
                runToolAction(tool.name, () =>
                  tool.enabled
                    ? toolkitsState.disableTool(toolkit.id, tool.name)
                    : toolkitsState.enableTool(toolkit.id, tool.name),
                )}
            >
              {tool.enabled ? "Disable" : "Enable"}
            </Button>
          </div>

          {#if tool.requiredPermissions.length > 0}
            <button
              type="button"
              class="text-xs text-default-600 hover:text-default-800 text-left hover:cursor-pointer"
              onclick={() => toggleExpandTool(tool.name)}
            >
              {expanded ? "Hide" : "Show"} permissions ({tool.requiredPermissions.length})
            </button>
          {/if}

          {#if expanded}
            <div class="flex flex-col gap-1">
              {#each tool.requiredPermissions as decl (permissionKey(decl))}
                {@const key = permissionKey(decl)}
                {@const state = grantStateFor(tool, key)}
                <div class="flex flex-col gap-1 p-2 bg-surface-inset-strong rounded-medium">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-mono text-xs text-default-800 break-all">
                      {permissionSummary(decl)}
                    </span>
                    <span class="text-xs text-default-700 break-words">{decl.reason}</span>
                    {#if decl.optional}
                      <span class="text-xs text-default-600 italic">optional</span>
                    {/if}
                  </div>
                  <div class="flex items-center gap-3 text-xs">
                    <label class="flex items-center gap-1 hover:cursor-pointer">
                      <input
                        type="radio"
                        name={`${tool.name}::${key}`}
                        checked={state === "granted"}
                        disabled={busyId === `${tool.name}::${key}`}
                        onchange={() => handleGrantChange(tool, key, "granted")}
                      />
                      <span class="text-default-800">Grant</span>
                    </label>
                    <label class="flex items-center gap-1 hover:cursor-pointer">
                      <input
                        type="radio"
                        name={`${tool.name}::${key}`}
                        checked={state === "denied"}
                        disabled={busyId === `${tool.name}::${key}`}
                        onchange={() => handleGrantChange(tool, key, "denied")}
                      />
                      <span class="text-default-800">Deny</span>
                    </label>
                    {#if state === "ungranted"}
                      <span class="text-accent-yellow-600">Unset</span>
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
