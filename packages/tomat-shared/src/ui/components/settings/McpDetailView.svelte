<script lang="ts">
  // Presentational body of an MCP server's detail editor: the enable toggle with
  // its status line, the name field, the transport select, and the transport-
  // specific fields (stdio command/args with an optional bundled-deno runtime and
  // its permissions, or a remote URL with a bearer token), plus the live prompts
  // list. The client owns the draft state, the debounced save, the secret-token
  // write-only handling, and the enable-confirmation flow; this View stays pure:
  // it takes the draft field values + status as data and emits on*-change
  // callbacks, with a pre-filtered prompts array toggled via onTogglePrompt.
  import type { McpConnectionStatus, McpStdioRuntime, McpTransportKind } from "../../../domain/mcp.ts";
  import FormField from "../primitives/FormField.svelte";
  import Input from "../primitives/Input.svelte";
  import Select from "../primitives/Select.svelte";
  import Toggle from "../primitives/Toggle.svelte";

  // One prompt row the live server exposes, pre-filtered to this server by the
  // client and toggled for "/" autocomplete.
  interface PromptRow {
    name: string;
    description?: string;
    enabled: boolean;
  }

  // `horizontal` mirrors the settings-panel layout flag: controls sit to the
  // right of their label when there is room, and stack below when narrow.
  let {
    enabled = false,
    status,
    statusError = undefined,
    hasAuth = false,
    draftName,
    draftKind,
    draftCommand,
    draftArgs,
    draftRuntime,
    draftAllowAll,
    draftPermissions,
    draftUrl,
    draftAuthToken,
    prompts = [],
    horizontal = false,
    onToggleEnabled = noop,
    onNameInput = noop,
    onKindChange = noop,
    onRuntimeChange = noop,
    onCommandInput = noop,
    onArgsInput = noop,
    onToggleAllowAll = noop,
    onPermissionsInput = noop,
    onUrlInput = noop,
    onAuthTokenInput = noop,
    onFlush = noop,
    onTogglePrompt = noop,
  }: {
    enabled?: boolean;
    status: McpConnectionStatus;
    statusError?: string;
    hasAuth?: boolean;
    draftName: string;
    draftKind: McpTransportKind;
    draftCommand: string;
    draftArgs: string;
    draftRuntime: McpStdioRuntime;
    draftAllowAll: boolean;
    draftPermissions: string;
    draftUrl: string;
    draftAuthToken: string;
    prompts?: PromptRow[];
    horizontal?: boolean;
    onToggleEnabled?: (enabled: boolean) => void;
    onNameInput?: (v: string) => void;
    onKindChange?: (v: McpTransportKind) => void;
    onRuntimeChange?: (v: McpStdioRuntime) => void;
    onCommandInput?: (v: string) => void;
    onArgsInput?: (v: string) => void;
    onToggleAllowAll?: (v: boolean) => void;
    onPermissionsInput?: (v: string) => void;
    onUrlInput?: (v: string) => void;
    onAuthTokenInput?: (v: string) => void;
    onFlush?: () => void;
    onTogglePrompt?: (name: string, enabled: boolean) => void;
  } = $props();

  function noop(): void {}

  const KIND_OPTIONS = [
    { value: "stdio", label: "Local (stdio)" },
    { value: "remote", label: "Remote (HTTP/SSE)" },
  ];

  const RUNTIME_OPTIONS = [
    { value: "custom", label: "Custom command" },
    { value: "deno", label: "Bundled deno" },
  ];
</script>

<div class="flex flex-col gap-3">
  <div class="flex {horizontal ? 'items-center justify-between gap-3' : 'flex-col gap-1.5'}">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800">Connect</span>
      {#if status === "error" && statusError}
        <span class="text-xs text-accent-red-600 break-words">{statusError}</span>
      {:else}
        <span class="text-xs text-default-600">Status: {status}</span>
      {/if}
    </div>
    <div class={horizontal ? "w-28 shrink-0" : ""}>
      <Toggle
        compact
        labels={{ on: "ON", off: "OFF" }}
        checked={enabled}
        ariaLabel="Enable server"
        onchange={(v) => onToggleEnabled(v)}
      />
    </div>
  </div>

  <FormField label="Name">
    <Input
      type="text"
      value={draftName}
      ariaLabel="Server name"
      oninput={(v) => onNameInput(v)}
      onblur={() => onFlush()}
    />
  </FormField>

  <FormField label="Transport">
    <Select
      value={draftKind}
      options={KIND_OPTIONS}
      ariaLabel="Transport"
      onchange={(v) => onKindChange(v as McpTransportKind)}
    />
  </FormField>

  {#if draftKind === "stdio"}
    <FormField label="Runtime">
      <Select
        value={draftRuntime}
        options={RUNTIME_OPTIONS}
        ariaLabel="Runtime"
        onchange={(v) => onRuntimeChange(v as McpStdioRuntime)}
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
          oninput={(v) => onCommandInput(v)}
          onblur={() => onFlush()}
        />
      </FormField>
      <FormField label="Arguments">
        <Input
          type="text"
          value={draftArgs}
          mono
          ariaLabel="Arguments"
          oninput={(v) => onArgsInput(v)}
          onblur={() => onFlush()}
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
              onchange={(v) => onToggleAllowAll(v)}
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
              oninput={(v) => onPermissionsInput(v)}
              onblur={() => onFlush()}
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
          oninput={(v) => onCommandInput(v)}
          onblur={() => onFlush()}
        />
      </FormField>
      <FormField label="Arguments">
        <Input
          type="text"
          value={draftArgs}
          placeholder="-y @some/mcp-server"
          mono
          ariaLabel="Arguments"
          oninput={(v) => onArgsInput(v)}
          onblur={() => onFlush()}
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
        oninput={(v) => onUrlInput(v)}
        onblur={() => onFlush()}
      />
    </FormField>
    <FormField label="Bearer token">
      <Input
        type="password"
        value={draftAuthToken}
        placeholder={hasAuth ? "(stored - leave blank to keep)" : "optional"}
        mono
        ariaLabel="Bearer token"
        oninput={(v) => onAuthTokenInput(v)}
        onblur={() => onFlush()}
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
              onchange={(v) => onTogglePrompt(p.name, v)}
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
