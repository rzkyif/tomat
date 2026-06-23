<script lang="ts">
  import { untrack } from "svelte";
  import { errMessage, type McpServer } from "@tomat/shared";
  import { confirmState, mcpState } from "$stores";
  import { getLogger } from "$lib/util/log";
  import FormField from "@tomat/shared/ui/components/primitives/FormField.svelte";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import Select from "@tomat/shared/ui/components/primitives/Select.svelte";
  import Toggle from "@tomat/shared/ui/components/primitives/Toggle.svelte";

  const log = getLogger("mcp");

  let { server, horizontal = false, reload }: {
    server: McpServer;
    horizontal?: boolean;
    reload: () => void;
  } = $props();

  let draftName = $state(untrack(() => server.name));
  let draftKind = $state<"stdio" | "remote">(untrack(() => server.kind));
  let draftCommand = $state(untrack(() => server.command ?? ""));
  let draftArgs = $state(untrack(() => (server.args ?? []).join(" ")));
  // stdio runtime: "custom" runs the command verbatim, "deno" runs it through
  // the bundled deno binary (so npm-based servers need no Node.js install).
  let draftRuntime = $state<"custom" | "deno">(untrack(() => server.runtime));
  let draftAllowAll = $state(untrack(() => server.denoAllowAll));
  let draftPermissions = $state(untrack(() => (server.denoPermissions ?? []).join(" ")));
  let draftUrl = $state(untrack(() => server.url ?? ""));
  // The bearer token is write-only: core never sends it back, so the field
  // starts blank and is persisted only once the user edits it (so an untouched
  // save doesn't wipe an existing token).
  let draftAuthToken = $state("");
  let authTouched = $state(false);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Prompts the live server exposes, toggled for "/" autocomplete.
  const prompts = $derived(mcpState.prompts.filter((p) => p.serverId === server.id));

  const KIND_OPTIONS = [
    { value: "stdio", label: "Local (stdio)" },
    { value: "remote", label: "Remote (HTTP/SSE)" },
  ];

  const RUNTIME_OPTIONS = [
    { value: "custom", label: "Custom command" },
    { value: "deno", label: "Bundled deno" },
  ];

  // The command actually run for a stdio server, shown in the enable
  // confirmation so consent reflects what launches.
  function effectiveCommand(): string {
    if (draftRuntime === "deno") {
      const perms = draftAllowAll ? "--allow-all" : draftPermissions.trim();
      return `deno run ${perms} ${draftCommand.trim()} ${draftArgs.trim()}`
        .replace(/\s+/g, " ")
        .trim();
    }
    return `${draftCommand.trim()} ${draftArgs.trim()}`.trim();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 600);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      await mcpState.update(server.id, {
        name: draftName.trim() || "Untitled",
        kind: draftKind,
        command: draftKind === "stdio" ? draftCommand.trim() : undefined,
        args: draftArgs.trim() ? draftArgs.trim().split(/\s+/) : [],
        runtime: draftRuntime,
        denoAllowAll: draftAllowAll,
        denoPermissions: draftPermissions.trim() ? draftPermissions.trim().split(/\s+/) : [],
        url: draftKind === "remote" ? draftUrl.trim() : undefined,
        // Only send the token field once the user has touched it.
        ...(authTouched ? { authToken: draftAuthToken } : {}),
      });
      reload();
    } catch (e) {
      log.error("save MCP server failed:", e);
    }
  }

  async function applyEnabled(enabled: boolean) {
    try {
      await mcpState.update(server.id, { enabled });
      reload();
    } catch (e) {
      confirmState.alert({ title: "Action failed", message: errMessage(e) });
    }
  }

  function toggleEnabled(enabled: boolean) {
    // Disabling is harmless; enabling spawns a local subprocess (stdio) or
    // opens a network connection (remote), so confirm first. A stdio server
    // runs an arbitrary command OUTSIDE the tool sandbox, so this is the
    // consent gate for executing it.
    if (!enabled) {
      void applyEnabled(false);
      return;
    }
    const cmd = effectiveCommand();
    const message = draftKind === "stdio"
      ? `Enabling this server runs the command "${cmd}" on your machine. It ` +
        `runs OUTSIDE the tool sandbox with your full access. Only enable MCP ` +
        `servers you trust.`
      : `Enabling this server connects to ${
        draftUrl.trim()
      } and sends it your requests${
        server.hasAuth ? " with your stored token" : ""
      }. Only enable MCP servers you trust.`;
    confirmState.request({
      title: "Enable MCP server?",
      message,
      confirmLabel: "Enable",
      onConfirm: () => applyEnabled(true),
    });
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex {horizontal ? 'items-center justify-between gap-3' : 'flex-col gap-1.5'}">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800">Connect</span>
      {#if server.status === "error" && server.statusError}
        <span class="text-xs text-accent-red-600 break-words">{server.statusError}</span>
      {:else}
        <span class="text-xs text-default-600">Status: {server.status}</span>
      {/if}
    </div>
    <div class={horizontal ? "w-28 shrink-0" : ""}>
      <Toggle
        compact
        labels={{ on: "ON", off: "OFF" }}
        checked={server.enabled}
        ariaLabel="Enable server"
        onchange={(v) => toggleEnabled(v)}
      />
    </div>
  </div>

  <FormField label="Name">
    <Input
      type="text"
      value={draftName}
      ariaLabel="Server name"
      oninput={(v) => {
        draftName = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Transport">
    <Select
      value={draftKind}
      options={KIND_OPTIONS}
      ariaLabel="Transport"
      onchange={(v) => {
        draftKind = v as "stdio" | "remote";
        scheduleSave();
      }}
    />
  </FormField>

  {#if draftKind === "stdio"}
    <FormField label="Runtime">
      <Select
        value={draftRuntime}
        options={RUNTIME_OPTIONS}
        ariaLabel="Runtime"
        onchange={(v) => {
          draftRuntime = v as "custom" | "deno";
          scheduleSave();
        }}
      />
    </FormField>

    {#if draftRuntime === "deno"}
      <FormField label="Package or Script">
        <Input
          type="text"
          value={draftCommand}
          placeholder="npm:@scope/server"
          mono
          ariaLabel="Package or script"
          oninput={(v) => {
            draftCommand = v;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        />
      </FormField>
      <FormField label="Arguments">
        <Input
          type="text"
          value={draftArgs}
          mono
          ariaLabel="Arguments"
          oninput={(v) => {
            draftArgs = v;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        />
      </FormField>
      <div class="flex flex-col gap-1.5 pt-2 border-t border-surface">
        <div class="flex {horizontal ? 'items-center justify-between gap-3' : 'flex-col gap-1.5'}">
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-sm text-default-800">Full Access</span>
            <span class="text-xs text-default-600">
              Runs with full access for the widest compatibility. Turn off to choose permissions
              yourself.
            </span>
          </div>
          <div class={horizontal ? "w-28 shrink-0" : ""}>
            <Toggle
              compact
              labels={{ on: "ON", off: "OFF" }}
              checked={draftAllowAll}
              ariaLabel="Full access"
              onchange={(v) => {
                draftAllowAll = v;
                scheduleSave();
              }}
            />
          </div>
        </div>
        {#if !draftAllowAll}
          <FormField label="Permissions">
            <Input
              type="text"
              value={draftPermissions}
              placeholder="--allow-net --allow-read=/path"
              mono
              ariaLabel="Permissions"
              oninput={(v) => {
                draftPermissions = v;
                scheduleSave();
              }}
              onblur={() => flushSave()}
            />
          </FormField>
        {/if}
      </div>
    {:else}
      <FormField label="Command">
        <Input
          type="text"
          value={draftCommand}
          placeholder="npx"
          mono
          ariaLabel="Command"
          oninput={(v) => {
            draftCommand = v;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        />
      </FormField>
      <FormField label="Arguments">
        <Input
          type="text"
          value={draftArgs}
          placeholder="-y @some/mcp-server"
          mono
          ariaLabel="Arguments"
          oninput={(v) => {
            draftArgs = v;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        />
      </FormField>
    {/if}
  {:else}
    <FormField label="URL">
      <Input
        type="text"
        value={draftUrl}
        placeholder="https://example.com/mcp"
        mono
        ariaLabel="URL"
        oninput={(v) => {
          draftUrl = v;
          scheduleSave();
        }}
        onblur={() => flushSave()}
      />
    </FormField>
    <FormField label="Bearer token">
      <Input
        type="password"
        value={draftAuthToken}
        placeholder={server.hasAuth ? "(stored - leave blank to keep)" : "optional"}
        mono
        ariaLabel="Bearer token"
        oninput={(v) => {
          draftAuthToken = v;
          authTouched = true;
          scheduleSave();
        }}
        onblur={() => flushSave()}
      />
    </FormField>
  {/if}

  {#if prompts.length > 0}
    <div class="flex flex-col gap-1.5 pt-2 border-t border-surface">
      <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
        Prompts (trigger with /)
      </div>
      {#each prompts as p (p.name)}
        <div class="flex {horizontal ? 'items-center justify-between gap-3' : 'flex-col gap-1'}">
          <div class="flex flex-col gap-0.5 min-w-0">
            <code class="text-xs text-default-800 self-start">/{p.name}</code>
            {#if p.description}
              <span class="text-xs text-default-600 break-words">{p.description}</span>
            {/if}
          </div>
          <div class={horizontal ? "w-28 shrink-0" : ""}>
            <Toggle
              compact
              labels={{ on: "ON", off: "OFF" }}
              checked={p.enabled}
              ariaLabel={`Enable /${p.name}`}
              onchange={(v) => void mcpState.setPromptEnabled(server.id, p.name, v)}
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
