<script lang="ts">
  import type { Snippet } from "svelte";
  import CollapsibleLabel from "./CollapsibleLabel.svelte";

  // A sidebar row: leading icon + collapsible label, with selected / hover /
  // ping states. Shared so the client settings sidebar and the website showcase
  // render rows identically. Interactive states use the `hov:` variant so a
  // scripted demo cursor (setting `data-hover`) resolves the same styles as a
  // real pointer.
  let {
    icon,
    label,
    collapsed,
    selected = false,
    ping = false,
    pingTone = "default",
    badge,
    onclick,
    title,
    ariaLabel,
    ariaPressed,
    disabled = false,
    class: extraClass = "",
  }: {
    icon: string;
    label?: string;
    collapsed: boolean;
    selected?: boolean;
    /** Pulse the text color to draw the eye (attention "ping"). */
    ping?: boolean;
    /** Ping palette: "default" pulses grey brightness, "accent" pulses yellow. */
    pingTone?: "default" | "accent";
    /** Optional badge content at the icon's top-right. */
    badge?: Snippet;
    onclick: () => void;
    title?: string;
    ariaLabel?: string;
    ariaPressed?: boolean;
    disabled?: boolean;
    class?: string;
  } = $props();

  // With a label the trailing pad collapses with it so the row reduces to a
  // centred icon; icon-only rows stay symmetric rectangles.
  const padRight = $derived(label ? (collapsed ? "pr-0" : "pr-2.5") : "pr-1.5");

  // Press deepens the inset surface one further step (the shared interaction
  // standard) on top of each row's hover/selected background.
  const stateClass = $derived(
    selected
      ? "bg-surface-inset text-default-900 act:bg-surface-inset-strong"
      : pingTone === "accent"
        ? ping
          ? "text-accent-yellow-700 hov:bg-surface-inset act:bg-surface-inset-strong"
          : "text-accent-yellow-500 hov:bg-surface-inset act:bg-surface-inset-strong"
        : ping
          ? "text-default-700 hov:bg-surface-inset act:bg-surface-inset-strong"
          : "text-default-500 hov:text-default-700 hov:bg-surface-inset act:bg-surface-inset-strong",
  );
</script>

<!-- color/background-color use the shared 120ms interaction feedback (kept in
     sync with INTERACTIVE_MS / `transition-interactive`); padding keeps its own
     200ms because it animates the sidebar collapse, not button feedback, and so
     cannot share the single-property `transition-interactive` shortcut. -->
<button
  class="hov:cursor-pointer flex items-center h-8 pl-1.5 {padRight} gap-1.5 rounded-medium [transition:color_120ms,background-color_120ms,padding_200ms] disabled:opacity-50 disabled:pointer-events-none {stateClass} {extraClass}"
  {title}
  aria-label={ariaLabel ?? label}
  aria-pressed={ariaPressed}
  {disabled}
  {onclick}
>
  <span class="relative flex shrink-0">
    <i class="flex text-xl shrink-0 {icon}"></i>
    {#if badge}
      {@render badge()}
    {/if}
  </span>
  {#if label}
    <CollapsibleLabel {collapsed} class="text-base text-left">
      {label}
    </CollapsibleLabel>
  {/if}
</button>
