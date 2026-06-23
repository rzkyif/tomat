<script lang="ts">
  import {
    errMessage,
    type Grant,
    type GrantState,
    permissionKey,
    type Tool,
  } from "@tomat/shared";
  import { confirmState, settingsState, extensionsState, mcpState } from "$stores";
  import Toggle from "@tomat/shared/ui/components/primitives/Toggle.svelte";

  // One tool's enable toggle and permission grants. Provider-agnostic: extension
  // tools carry sandbox permissions managed here; MCP tools run on their server
  // and only carry an enable toggle.
  let { tool, horizontal = false }: { tool: Tool; horizontal?: boolean } = $props();

  let busyId = $state<string | null>(null);

  // Extension tools toggle through the extensions API (with grant refresh); MCP
  // tools toggle on their server, then refresh the flat tool list.
  async function setEnabled(enabled: boolean): Promise<void> {
    if (tool.providerKind === "mcp") {
      await mcpState.setToolEnabled(tool.extensionId, tool.name, enabled);
      await extensionsState.loadAllTools();
    } else if (enabled) {
      await extensionsState.enableTool(tool.extensionId, tool.name);
    } else {
      await extensionsState.disableTool(tool.extensionId, tool.name);
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

  function grantStateFor(t: Tool, key: string): GrantState {
    return t.grants.find((g) => g.permissionKey === key)?.state ?? "ask";
  }

  const GRANT_OPTIONS = [
    { value: "denied", label: "Deny" },
    { value: "ask", label: "Ask" },
    { value: "granted", label: "Allow" },
  ];

  function riskyWarning(decl: Tool["requiredPermissions"][number]): string | null {
    switch (decl.kind) {
      case "run":
        return `The tool will be able to run the ${decl.binary} program at any time without asking you. Programs it runs are not sandboxed and can do anything you can do on this computer.`;
      case "ffi":
        return "The tool will be able to load native libraries at any time without asking you. Native code runs outside the sandbox and can do anything you can do on this computer.";
      case "write":
        return `The tool will be able to change or delete files under ${decl.path} at any time without asking you.`;
      case "net":
        return decl.host === "*"
          ? "The tool will be able to connect to any server on the internet at any time without asking you, including sending data it has access to."
          : null;
      default:
        return null;
    }
  }

  async function applyGrantChange(permKey: string, nextState: GrantState) {
    const merged: Array<{ key: string; state: Grant["state"] }> = [];
    for (const g of tool.grants) {
      if (g.permissionKey !== permKey) merged.push({ key: g.permissionKey, state: g.state });
    }
    merged.push({ key: permKey, state: nextState });
    await runToolAction(`${tool.name}::${permKey}`, () =>
      extensionsState.setGrants(tool.extensionId, tool.name, merged),
    );
  }

  function handleGrantChange(
    decl: Tool["requiredPermissions"][number],
    permKey: string,
    nextState: GrantState,
  ) {
    if (busyId !== null) return;
    const warning = nextState === "granted" ? riskyWarning(decl) : null;
    const suppressed = settingsState.currentSettings["extensions.skipRiskyGrantWarning"] === true;
    if (!warning || suppressed) {
      void applyGrantChange(permKey, nextState);
      return;
    }
    confirmState.request({
      title: "Always allow this permission?",
      message: warning,
      confirmLabel: "Always Allow",
      destructive: true,
      dontShowAgainLabel: "Do not warn me about risky permissions again",
      onConfirm: (dontShowAgain) => {
        if (dontShowAgain) {
          void settingsState.updateSetting("extensions.skipRiskyGrantWarning", true);
        }
        void applyGrantChange(permKey, nextState);
      },
    });
  }

  function sortedPermissions(t: Tool): Tool["requiredPermissions"] {
    return [...t.requiredPermissions].sort(
      (a, b) => Number(a.optional ?? false) - Number(b.optional ?? false),
    );
  }

  const codeClass =
    "font-mono bg-surface-inset text-default-800 rounded-small px-1.5 py-0.5 break-all";

  function permissionParts(decl: Tool["requiredPermissions"][number]): {
    before: string;
    code?: string;
    after: string;
  } {
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
      case "memories":
        return decl.access === "write"
          ? { before: "Create and edit your memories", after: "" }
          : { before: "Read your memories", after: "" };
      case "llm":
        return { before: "Generate text with the model", after: "" };
      case "tts":
        return { before: "Speak text aloud", after: "" };
      case "stt":
        return { before: "Transcribe audio to text", after: "" };
    }
  }

  const deniedRequired = $derived(
    tool.requiredPermissions.filter(
      (d) => !d.optional && grantStateFor(tool, permissionKey(d)) === "denied",
    ).length,
  );
</script>

<div class="flex flex-col gap-3">
  <div
    class="flex {horizontal ? 'items-start justify-between gap-3' : 'flex-col gap-1.5'}"
  >
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-sm text-default-800">Enabled</span>
      {#if tool.enabled && deniedRequired > 0}
        <span class="text-xs text-accent-yellow-600">
          Enabled, but not offered to the agent while a required permission is denied.
        </span>
      {/if}
    </div>
    <div class={horizontal ? "w-36 shrink-0" : ""}>
      <Toggle
        compact
        labels={{ on: "ENABLED", off: "DISABLED" }}
        checked={tool.enabled}
        disabled={busyId === tool.name}
        ariaLabel={`Enable ${tool.name}`}
        onchange={(v) =>
          runToolAction(tool.name, () => setEnabled(v))}
      />
    </div>
  </div>

  {#if tool.requiredPermissions.length > 0}
    <div class="flex flex-col gap-1.5">
      <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
        Permissions
      </div>
      {#each sortedPermissions(tool) as decl (permissionKey(decl))}
        {@const key = permissionKey(decl)}
        {@const state = grantStateFor(tool, key)}
        {@const parts = permissionParts(decl)}
        <div
          class="flex {horizontal ? 'items-start justify-between gap-3' : 'flex-col gap-1.5'}"
        >
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-xs text-default-800 break-words">
              {parts.before}{#if parts.code}<code class={codeClass}>{parts.code}</code>{/if}{parts.after}{#if !decl.optional}<span
                  class="text-default-500 ml-1.5">(required)</span
                >{/if}
            </span>
            <span class="text-xs text-default-600 break-words">{decl.reason}</span>
          </div>
          <div class={horizontal ? "w-44 shrink-0" : ""}>
            <Toggle
              value={state}
              options={GRANT_OPTIONS}
              ariaLabel={`${parts.before}${parts.code ?? ""}${parts.after}`}
              onselect={(v) => handleGrantChange(decl, key, v as GrantState)}
            />
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <span class="text-xs text-default-600 italic">
      This tool needs no special permissions.
    </span>
  {/if}
</div>
