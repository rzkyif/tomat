<script lang="ts">
  // One Quick Settings accordion section: a header row (an expand button plus an
  // optional module on/off toggle) and, while open, a vertically scrollable body
  // supplied by the caller. The toggle is a sibling of the expand button, not a
  // child: nesting the Toggle's input inside a <button> would be invalid HTML.
  // Pure: the client owns the schema fields it renders into `body` and the live
  // enabled/open state; this draws the chrome and emits the interactions back.
  import type { Snippet } from "svelte";
  import Expand from "../primitives/Expand.svelte";
  import Toggle from "../primitives/Toggle.svelte";

  let {
    title,
    open = false,
    enabled = true,
    hasToggle = false,
    onToggleExpand = noop,
    onSetEnabled = noopBool,
    body,
  }: {
    title: string;
    /** Body rendered. The caller derives this as `selected && enabled`, so a
     *  disabled module can never be open. */
    open?: boolean;
    enabled?: boolean;
    /** Whether the module has an on/off toggle in its header. */
    hasToggle?: boolean;
    onToggleExpand?: () => void;
    onSetEnabled?: (value: boolean) => void;
    body: Snippet;
  } = $props();

  function noop(): void {}
  function noopBool(_value: boolean): void {}
</script>

<!-- The open section claims the remaining panel height and scrolls inside it;
     closed sections are fixed header rows. -->
<div class="flex flex-col {open ? 'flex-1 min-h-0' : 'shrink-0'}">
  <div class="flex items-center gap-2 shrink-0">
    <button
      type="button"
      class="flex flex-1 items-center gap-2 py-2 text-default-800 cursor-pointer transition-colors hover:text-default-900 disabled:opacity-50 disabled:cursor-default"
      disabled={!enabled}
      aria-expanded={open}
      onclick={onToggleExpand}
    >
      <i
        class="flex text-xl transition-transform duration-200 {open
          ? 'i-material-symbols-keyboard-arrow-down-rounded'
          : 'i-material-symbols-chevron-right-rounded'}"
      ></i>
      <span class="flex-1 text-left text-base font-medium">{title}</span>
    </button>
    {#if hasToggle}
      <div class="w-24 shrink-0">
        <Toggle
          compact
          labels={{ on: "ON", off: "OFF" }}
          checked={enabled}
          ariaLabel={`Enable ${title}`}
          onchange={onSetEnabled}
        />
      </div>
    {/if}
  </div>
  <!-- pl-7 lines the field column up under the header title: chevron
       (text-xl, 1.25rem) + the header's gap-2 (0.5rem). The Expand wrapper
       doubles as the scroll container: runExpand reads its scrollHeight,
       which a scroll container reports as the full content height even while
       max-height clamps it, so the open/close sweep tracks the real size. -->
  <Expand {open} class="tomat-scroll overflow-y-auto min-h-0 flex flex-col gap-1 pl-7 pr-2 pb-1">
    {@render body()}
  </Expand>
</div>
