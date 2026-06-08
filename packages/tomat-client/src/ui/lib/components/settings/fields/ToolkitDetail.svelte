<script lang="ts">
  import { onMount } from "svelte";
  import { errMessage, type Grant, permissionKey, type Tool, type Toolkit } from "@tomat/shared";
  import { confirmState, toolkitsState } from "$lib/state";
  import Toggle from "$lib/components/ui/Toggle.svelte";

  let { toolkit }: { toolkit: Toolkit } = $props();

  let busyId = $state<string | null>(null);
  let loadingTools = $state(false);
  let toolsError = $state<string | null>(null);

  // A drifted toolkit had its tools disabled; block all toggling until the user
  // confirms re-enable (from the toolkit menu), which re-pins the content hash.
  const drifted = $derived(toolkit.status === "drift");

  onMount(() => {
    if (!toolkit.tools) void loadTools(toolkit.id);
  });

  async function loadTools(id: string) {
    loadingTools = true;
    toolsError = null;
    try {
      await toolkitsState.loadTools(id);
    } catch (e) {
      toolsError = errMessage(e);
    } finally {
      loadingTools = false;
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

  function grantStateFor(tool: Tool, key: string): "granted" | "denied" | "ungranted" {
    return tool.grants.find((g) => g.permissionKey === key)?.state ?? "ungranted";
  }

  async function handleGrantChange(tool: Tool, permKey: string, nextState: "granted" | "denied") {
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

  // Required permissions first, optional ones after; original order within each
  // group is preserved (stable sort).
  function sortedPermissions(tool: Tool): Tool["requiredPermissions"] {
    return [...tool.requiredPermissions].sort(
      (a, b) => Number(a.optional ?? false) - Number(b.optional ?? false),
    );
  }

  // Inline-code chip styling: mono on a light inset surface (bg-surface-inset),
  // so arbitrary values (hosts, paths, env names, ...) read like inline code but
  // stay legible against the settings panel.
  const codeClass = "font-mono bg-surface-inset text-default-800 rounded-small px-1.5 py-0.5 break-all";

  // A permission as a sentence with its arbitrary value split out so the template
  // can render that value as an inline-code chip.
  function permissionParts(
    decl: Tool["requiredPermissions"][number],
  ): { before: string; code?: string; after: string } {
    switch (decl.kind) {
      case "net":
        return {
          before: "Network access to ",
          code: `${decl.host}:${decl.ports.map(String).join(",")}`,
          after: "",
        };
      case "read":
        return { before: "Read files at ", code: decl.path, after: "" };
      case "write":
        return { before: "Write files at ", code: decl.path, after: "" };
      case "run":
        return { before: "Run the ", code: decl.binary, after: " command" };
      case "env":
        return { before: "Read the ", code: decl.key, after: " environment variable" };
      case "ffi":
        return { before: "Load native libraries (FFI)", after: "" };
      case "sys":
        return { before: "Read system info (", code: decl.flag, after: ")" };
    }
  }
</script>

<div class="flex flex-col">
  {#if toolsError}
    <div class="text-sm text-accent-red-600 break-words pb-2">{toolsError}</div>
  {/if}

  {#if drifted}
    <div class="flex flex-col gap-1 p-3 mb-1 bg-surface-inset rounded-large">
      <span class="text-sm text-accent-red-600">Content changed since install</span>
      <span class="text-xs text-default-700 break-words">
        This toolkit's files changed on disk, so its tools were disabled. Review the change,
        then choose "Review &amp; re-enable" from the toolkit menu to trust the current contents.
      </span>
    </div>
  {/if}

  {#if loadingTools && !toolkit.tools}
    <div class="flex justify-center py-6 text-default-500">
      <i class="i-material-symbols-progress-activity animate-spin text-lg"></i>
    </div>
  {:else if toolkit.tools && toolkit.tools.length === 0}
    <div class="text-sm text-default-600 italic py-2">No tools declared.</div>
  {:else if toolkit.tools}
    {#each toolkit.tools as tool (tool.id)}
      {@const missing = tool.missingRequired.length}
      <div class="flex flex-col gap-2 py-3 border-t border-surface first:border-t-0">
        <div class="flex items-start justify-between gap-3">
          <div class="flex flex-col gap-1 min-w-0">
            <code class="{codeClass} text-sm self-start">{tool.name}</code>
            {#if tool.description}
              <span class="text-xs text-default-600 break-words">{tool.description}</span>
            {/if}
            {#if tool.enabled && missing > 0}
              <span class="text-xs text-accent-yellow-600">
                Enabled, but not active until its required permissions are allowed.
              </span>
            {/if}
          </div>
          <div class="w-36 shrink-0">
            <Toggle
              compact
              labels={{ on: "ENABLED", off: "DISABLED" }}
              checked={tool.enabled}
              disabled={busyId === tool.name || drifted}
              ariaLabel={`Enable ${tool.name}`}
              onchange={(v) =>
                runToolAction(tool.name, () =>
                  v
                    ? toolkitsState.enableTool(toolkit.id, tool.name)
                    : toolkitsState.disableTool(toolkit.id, tool.name),
                )}
            />
          </div>
        </div>

        {#if tool.requiredPermissions.length > 0}
          <div class="flex flex-col gap-1.5 pl-3">
            <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
              Permissions
            </div>
            {#each sortedPermissions(tool) as decl (permissionKey(decl))}
              {@const key = permissionKey(decl)}
              {@const state = grantStateFor(tool, key)}
              {@const parts = permissionParts(decl)}
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-xs text-default-800 break-words">
                    {parts.before}{#if parts.code}<code class={codeClass}>{parts.code}</code>{/if}{parts.after}{#if !decl.optional}<span
                        class="text-default-500 ml-1.5">(required)</span
                      >{/if}
                  </span>
                  <span class="text-xs text-default-600 break-words">{decl.reason}</span>
                </div>
                <div class="w-36 shrink-0">
                  <Toggle
                    compact
                    labels={{ on: "ALLOWED", off: "DENIED" }}
                    checked={state === "granted"}
                    disabled={busyId === `${tool.name}::${key}`}
                    ariaLabel={`${parts.before}${parts.code ?? ""}${parts.after}`}
                    onchange={(v) => handleGrantChange(tool, key, v ? "granted" : "denied")}
                  />
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
