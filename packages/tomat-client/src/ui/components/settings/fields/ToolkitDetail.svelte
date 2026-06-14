<script lang="ts">
  import { onMount } from "svelte";
  import {
    errMessage,
    type Grant,
    type GrantState,
    permissionKey,
    type Tool,
    type Toolkit,
  } from "@tomat/shared";
  import { confirmState, settingsState, toolkitsState } from "$stores";
  import Toggle from "$components/ui/Toggle.svelte";

  // `horizontal` mirrors the settings-panel layout flag: controls sit to the
  // right of their label when there is room, and stack below the label +
  // description (like setting fields) when the panel is narrow.
  let { toolkit, horizontal = false }: {
    toolkit: Toolkit;
    horizontal?: boolean;
  } = $props();

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

  // An absent grant row behaves as "ask" at runtime, so the toggle shows it
  // as such.
  function grantStateFor(tool: Tool, key: string): GrantState {
    return tool.grants.find((g) => g.permissionKey === key)?.state ?? "ask";
  }

  const GRANT_OPTIONS = [
    { value: "denied", label: "Deny" },
    { value: "ask", label: "Ask" },
    { value: "granted", label: "Allow" },
  ];

  const POLICY_OPTIONS = [
    { value: "deny", label: "Deny" },
    { value: "ask", label: "Ask" },
  ];

  // "Always allow" on these permissions removes the runtime prompt for an
  // ability that can do real damage on its own, so it gets a confirm dialog.
  function riskyWarning(
    decl: Tool["requiredPermissions"][number],
  ): string | null {
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

  async function applyGrantChange(
    tool: Tool,
    permKey: string,
    nextState: GrantState,
  ) {
    const merged: Array<{ key: string; state: Grant["state"] }> = [];
    for (const g of tool.grants) {
      if (g.permissionKey !== permKey)
        merged.push({ key: g.permissionKey, state: g.state });
    }
    merged.push({ key: permKey, state: nextState });
    await runToolAction(`${tool.name}::${permKey}`, () =>
      toolkitsState.setGrants(toolkit.id, tool.name, merged),
    );
  }

  function handleGrantChange(
    tool: Tool,
    decl: Tool["requiredPermissions"][number],
    permKey: string,
    nextState: GrantState,
  ) {
    if (busyId !== null) return;
    const warning = nextState === "granted" ? riskyWarning(decl) : null;
    const suppressed =
      settingsState.currentSettings["toolkits.skipRiskyGrantWarning"] === true;
    if (!warning || suppressed) {
      void applyGrantChange(tool, permKey, nextState);
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
          void settingsState.updateSetting(
            "toolkits.skipRiskyGrantWarning",
            true,
          );
        }
        void applyGrantChange(tool, permKey, nextState);
      },
    });
  }

  async function handlePolicyChange(policy: "deny" | "ask") {
    await runToolAction(`${toolkit.id}::undeclared-policy`, () =>
      toolkitsState.setUndeclaredPolicy(toolkit.id, policy),
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
  const codeClass =
    "font-mono bg-surface-inset text-default-800 rounded-small px-1.5 py-0.5 break-all";

  // A permission as a sentence with its arbitrary value split out so the template
  // can render that value as an inline-code chip.
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
        return {
          before: "Read the ",
          code: decl.key,
          after: " environment variable",
        };
      case "ffi":
        return { before: "Load native libraries (FFI)", after: "" };
      case "sys":
        return { before: "Read system info (", code: decl.flag, after: ")" };
      case "documents":
        return decl.access === "write"
          ? { before: "Create and edit your documents", after: "" }
          : { before: "Read your documents", after: "" };
      case "llm":
        return { before: "Generate text with the model", after: "" };
      case "tts":
        return { before: "Speak text aloud", after: "" };
      case "stt":
        return { before: "Transcribe audio to text", after: "" };
    }
  }
</script>

<div class="flex flex-col">
  {#if toolsError}
    <div class="text-sm text-accent-red-600 break-words pb-2">{toolsError}</div>
  {/if}

  {#if drifted}
    <div class="flex flex-col gap-1 p-3 mb-1 bg-surface-inset rounded-large">
      <span class="text-sm text-accent-red-600"
        >Content changed since install</span
      >
      <span class="text-xs text-default-700 break-words">
        This toolkit's files changed on disk, so its tools were disabled. Review
        the change, then choose "Review &amp; re-enable" from the toolkit menu
        to trust the current contents.
      </span>
    </div>
  {/if}

  <div
    class="flex py-3 {horizontal
      ? 'items-start justify-between gap-3'
      : 'flex-col gap-1.5'}"
  >
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800"
        >Undeclared Permission Requests</span
      >
      <span class="text-xs text-default-600 break-words">
        Whether to automatically deny, or ask you, when a tol requests access
        this toolkit never declared.
      </span>
    </div>
    <div class={horizontal ? "w-36 shrink-0" : ""}>
      <Toggle
        value={toolkit.undeclaredPolicy}
        options={POLICY_OPTIONS}
        ariaLabel="Undeclared Permission Requests"
        onselect={(v) => handlePolicyChange(v as "deny" | "ask")}
      />
    </div>
  </div>

  {#if loadingTools && !toolkit.tools}
    <div class="flex justify-center py-6 text-default-500">
      <i class="i-material-symbols-progress-activity animate-spin text-lg"></i>
    </div>
  {:else if toolkit.tools && toolkit.tools.length === 0}
    <div class="text-sm text-default-600 italic py-2">No tools declared.</div>
  {:else if toolkit.tools}
    {#each toolkit.tools as tool (tool.id)}
      {@const deniedRequired = tool.requiredPermissions.filter(
        (d) =>
          !d.optional && grantStateFor(tool, permissionKey(d)) === "denied",
      ).length}
      <div
        class="flex flex-col gap-2 py-3 border-t border-surface first:border-t-0"
      >
        <div
          class="flex {horizontal
            ? 'items-start justify-between gap-3'
            : 'flex-col gap-1.5'}"
        >
          <div class="flex flex-col gap-1 min-w-0">
            <code class="{codeClass} text-sm self-start">{tool.name}</code>
            {#if tool.description}
              <span class="text-xs text-default-600 break-words"
                >{tool.description}</span
              >
            {/if}
            {#if tool.enabled && deniedRequired > 0}
              <span class="text-xs text-accent-yellow-600">
                Enabled, but not offered to the agent while a required
                permission is denied.
              </span>
            {/if}
          </div>
          <div class={horizontal ? "w-36 shrink-0" : ""}>
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
            <div
              class="text-default-400 text-[10px] uppercase tracking-wider select-none"
            >
              Permissions
            </div>
            {#each sortedPermissions(tool) as decl (permissionKey(decl))}
              {@const key = permissionKey(decl)}
              {@const state = grantStateFor(tool, key)}
              {@const parts = permissionParts(decl)}
              <div
                class="flex {horizontal
                  ? 'items-start justify-between gap-3'
                  : 'flex-col gap-1.5'}"
              >
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-xs text-default-800 break-words">
                    {parts.before}{#if parts.code}<code class={codeClass}
                        >{parts.code}</code
                      >{/if}{parts.after}{#if !decl.optional}<span
                        class="text-default-500 ml-1.5">(required)</span
                      >{/if}
                  </span>
                  <span class="text-xs text-default-600 break-words"
                    >{decl.reason}</span
                  >
                </div>
                <div class={horizontal ? "w-44 shrink-0" : ""}>
                  <Toggle
                    value={state}
                    options={GRANT_OPTIONS}
                    ariaLabel={`${parts.before}${parts.code ?? ""}${parts.after}`}
                    onselect={(v) =>
                      handleGrantChange(tool, decl, key, v as GrantState)}
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
