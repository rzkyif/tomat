<script lang="ts">
  // Presentational body of an installed extension's detail pane: the drift
  // warning, the undeclared-permission policy toggle, and the tool-count line.
  // The client computes the busy flag (an in-flight policy change) and handles
  // the actual mutation; this View stays pure: props in, callback out.
  import type { Extension } from "../../../domain/extension.ts";
  import Toggle from "../primitives/Toggle.svelte";

  // `horizontal` mirrors the settings-panel layout flag: controls sit to the
  // right of their label when there is room, and stack below when narrow.
  let { extension, horizontal = false, busy = false, onPolicyChange = noop }: {
    extension: Extension;
    horizontal?: boolean;
    busy?: boolean;
    onPolicyChange?: (policy: "deny" | "ask") => void;
  } = $props();

  function noop(): void {}

  // A drifted extension had its tools disabled; the user re-enables from the
  // extension menu ("Review & re-enable"), which re-pins the content hash.
  const drifted = $derived(extension.status === "drift");

  const POLICY_OPTIONS = [
    { value: "deny", label: "Deny" },
    { value: "ask", label: "Ask" },
  ];
</script>

<div class="flex flex-col">
  {#if drifted}
    <div class="flex flex-col gap-1 p-3 mb-1 bg-surface-inset rounded-large">
      <span class="text-sm text-accent-red-600">Content changed since install</span>
      <span class="text-xs text-default-700 break-words">
        This extension's files changed on disk, so its tools were disabled. Review the
        change, then choose "Review &amp; re-enable" from the extension menu to trust the
        current contents.
      </span>
    </div>
  {/if}

  <div
    class="flex py-3 {horizontal ? 'items-start justify-between gap-3' : 'flex-col gap-1.5'}"
  >
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800">Undeclared Permission Requests</span>
      <span class="text-xs text-default-600 break-words">
        Whether to automatically deny, or ask you, when a tool requests access this
        extension never declared.
      </span>
    </div>
    <div class={horizontal ? "w-36 shrink-0" : ""}>
      <Toggle
        value={extension.undeclaredPolicy}
        options={POLICY_OPTIONS}
        disabled={busy}
        ariaLabel="Undeclared Permission Requests"
        onselect={(v) => onPolicyChange(v as "deny" | "ask")}
      />
    </div>
  </div>

  <div class="text-xs text-default-600 break-words py-2 border-t border-surface">
    Provides {extension.toolCount}
    {extension.toolCount === 1 ? "tool" : "tools"} ({extension.enabledToolCount} enabled). Turn
    individual tools on and manage their permissions under Tools.
  </div>
</div>
