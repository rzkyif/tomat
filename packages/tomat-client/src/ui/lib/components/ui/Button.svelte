<script lang="ts">
  import type { Snippet } from "svelte";

  type Variant = "primary" | "secondary" | "destructive" | "ghost";
  type Size = "sm" | "md";

  let {
    variant = "secondary",
    size = "md",
    icon,
    disabled = false,
    loading = false,
    title,
    ariaLabel,
    type = "button",
    onclick,
    class: extraClass = "",
    children,
  }: {
    variant?: Variant;
    size?: Size;
    icon?: string;
    disabled?: boolean;
    /** Shows a spinner in place of `icon` and disables the button. */
    loading?: boolean;
    title?: string;
    ariaLabel?: string;
    type?: "button" | "submit";
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
  } = $props();

  const displayIcon = $derived(loading ? "i-material-symbols-progress-activity animate-spin" : icon);

  const variantClass = $derived(
    {
      primary: "bg-default-inverted-300 text-default-inverted-900",
      secondary: "bg-surface-inset text-default-800",
      destructive: "bg-accent-red-200 text-white",
      ghost: "bg-transparent text-default-800 hover:bg-surface-inset",
    }[variant],
  );

  const sizeClass = $derived(
    size === "sm"
      ? "px-2 py-1 text-xs gap-1"
      : "px-3 py-1.5 text-sm gap-1.5",
  );
</script>

<button
  {type}
  disabled={disabled || loading}
  {title}
  aria-label={ariaLabel}
  {onclick}
  class="inline-flex items-center justify-center rounded-medium {sizeClass} {variantClass} hover:cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none {extraClass}"
>
  {#if displayIcon}<i class="flex {displayIcon} {size === 'sm' ? 'text-sm' : 'text-base'} shrink-0"></i>{/if}
  {@render children?.()}
</button>
