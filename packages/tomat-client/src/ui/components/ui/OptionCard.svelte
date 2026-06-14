<script lang="ts">
  import type { Snippet } from "svelte";
  import HelpText from "./HelpText.svelte";

  type Size = "sm" | "md";
  type SelectedStyle = "invert" | "accent";
  type Accent = "blue" | "green" | "red" | "yellow" | "purple";

  let {
    selected,
    size = "md",
    selectedStyle = "invert",
    accent = "blue",
    icon,
    title,
    description,
    badges,
    onclick,
    ariaLabel,
    htmlTitle,
    class: extraClass = "",
    children,
  }: {
    selected: boolean;
    /** `sm` is a single-line, h-8 row button (for question options in
     *  ToolCall). `md` is a multi-line card (icon + title + badges +
     *  description) for preset pickers. */
    size?: Size;
    /** `invert` (default) flips bg/text on select, used by settings preset
     *  pickers and tool-call options. `accent` uses a coloured border + tinted
     *  bg on select, used by quick-settings model cards. */
    selectedStyle?: SelectedStyle;
    /** Accent hue when `selectedStyle === "accent"`. */
    accent?: Accent;
    icon?: string;
    title?: string;
    description?: string;
    badges?: Snippet;
    onclick: () => void;
    ariaLabel?: string;
    /** HTML `title` attribute (tooltip). */
    htmlTitle?: string;
    class?: string;
    /** Custom body. When provided, overrides the default icon/title/badges/
     *  description rendering. */
    children?: Snippet;
  } = $props();

  const sizeClass = $derived(
    size === "sm"
      ? "text-xs px-2 py-1 h-8 rounded gap-1.5"
      : "p-3 rounded-large gap-1.5",
  );

  // Full strings so the UnoCSS extractor sees every accent.
  const accentSelectedMap: Record<Accent, string> = {
    blue: "border-accent-blue-300 bg-accent-blue-100",
    green: "border-accent-green-300 bg-accent-green-100",
    red: "border-accent-red-300 bg-accent-red-100",
    yellow: "border-accent-yellow-300 bg-accent-yellow-100",
    purple: "border-accent-purple-300 bg-accent-purple-100",
  };

  const stateClass = $derived(
    selectedStyle === "accent"
      ? selected
        ? `border-2 ${accentSelectedMap[accent]} text-default-800`
        : "border-2 border-transparent bg-surface-inset hover:bg-surface-inset-strong text-default-800"
      : selected
        ? "bg-default-inverted-300 text-default-inverted-800"
        : "bg-surface-inset text-default-800",
  );

  const descriptionClass = $derived(
    selectedStyle === "invert" && selected
      ? "text-default-inverted-500"
      : "text-default-500",
  );

  const badgesTextClass = $derived(
    selectedStyle === "invert" && selected
      ? "text-default-inverted-600"
      : "text-default-600",
  );
</script>

<button
  type="button"
  class="cursor-pointer text-left flex flex-col outline-none transition-colors duration-100 {sizeClass} {stateClass} {extraClass}"
  title={htmlTitle}
  aria-label={ariaLabel}
  {onclick}
>
  {#if children}
    {@render children()}
  {:else if size === "sm"}
    {title}
  {:else}
    <div class="flex items-center gap-1.5">
      {#if icon}
        <i class="{icon} text-lg"></i>
      {/if}
      {#if title}
        <span class="text-base font-semibold leading-tight">{title}</span>
      {/if}
    </div>
    {#if badges}
      <div
        class="flex flex-wrap gap-x-3 gap-y-1 text-xs {badgesTextClass}"
      >
        {@render badges()}
      </div>
    {/if}
    {#if description}
      <HelpText
        text={description}
        variant="compact"
        class={descriptionClass}
      />
    {/if}
  {/if}
</button>
