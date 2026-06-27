<script lang="ts">
  // Presentational body of one tool's detail pane: the enable toggle (with the
  // "denied required permission" caveat) and the per-permission grant rows. All
  // values arrive pre-formatted (the client owns the tool, the busy state, the
  // grant lookups, and computes every permission label/aria string), so this
  // stays pure: props in, callbacks out. Provider-agnostic: a tool with no
  // declared permissions shows the empty note instead of the grant list.
  import Toggle from "../primitives/Toggle.svelte";
  import type { GrantState } from "../../../domain/extension.ts";

  // One permission row, fully pre-formatted by the client. `before`/`code`/
  // `after` are the three label spans (`code` renders in the inline code chip);
  // `required` toggles the "(required)" marker; `grantState` selects the toggle
  // cell; `ariaLabel` labels the grant toggle.
  interface PermissionRow {
    key: string;
    before: string;
    code?: string;
    after: string;
    required: boolean;
    reason: string;
    grantState: GrantState;
    ariaLabel: string;
  }

  let {
    enabled,
    horizontal = false,
    enableBusy = false,
    enableAriaLabel,
    deniedRequired = 0,
    permissions = [],
    onToggleEnabled,
    onGrantChange,
  }: {
    enabled: boolean;
    horizontal?: boolean;
    enableBusy?: boolean;
    enableAriaLabel: string;
    deniedRequired?: number;
    permissions?: PermissionRow[];
    onToggleEnabled?: (enabled: boolean) => void;
    onGrantChange?: (key: string, nextState: GrantState) => void;
  } = $props();

  const noop = (): void => {};

  const GRANT_OPTIONS = [
    { value: "denied", label: "Deny" },
    { value: "ask", label: "Ask" },
    { value: "granted", label: "Allow" },
  ];

  const codeClass =
    "font-mono bg-surface-inset text-default-800 rounded-small px-1.5 py-0.5 break-all";
</script>

<div class="flex flex-col gap-3">
  <div
    class="flex {horizontal ? 'items-start justify-between gap-3' : 'flex-col gap-1.5'}"
  >
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-sm text-default-800">Enabled</span>
      {#if enabled && deniedRequired > 0}
        <span class="text-xs text-accent-yellow-600">
          Enabled, but not offered to the agent while a required permission is denied.
        </span>
      {/if}
    </div>
    <div class={horizontal ? "w-36 shrink-0" : ""}>
      <Toggle
        compact
        labels={{ on: "ENABLED", off: "DISABLED" }}
        checked={enabled}
        disabled={enableBusy}
        ariaLabel={enableAriaLabel}
        onchange={(v) => (onToggleEnabled ?? noop)(v)}
      />
    </div>
  </div>

  {#if permissions.length > 0}
    <div class="flex flex-col gap-1.5">
      <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
        Permissions
      </div>
      {#each permissions as perm (perm.key)}
        <div
          class="flex {horizontal ? 'items-start justify-between gap-3' : 'flex-col gap-1.5'}"
        >
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-xs text-default-800 break-words">
              {perm.before}{#if perm.code}<code class={codeClass}>{perm.code}</code>{/if}{perm.after}{#if perm.required}<span
                  class="text-default-500 ml-1.5">(required)</span
                >{/if}
            </span>
            <span class="text-xs text-default-600 break-words">{perm.reason}</span>
          </div>
          <div class={horizontal ? "w-44 shrink-0" : ""}>
            <Toggle
              value={perm.grantState}
              options={GRANT_OPTIONS}
              ariaLabel={perm.ariaLabel}
              onselect={(v) => (onGrantChange ?? noop)(perm.key, v as GrantState)}
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
