<script lang="ts">
  import type { Snippet } from "svelte";

  type Variant = "primary" | "secondary" | "destructive" | "ghost";
  type Size = "sm" | "md";

  let {
    variant = "secondary",
    size = "md",
    icon,
    disabled = false,
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
    title?: string;
    ariaLabel?: string;
    type?: "button" | "submit";
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
  } = $props();

  const variantClass = $derived(
    {
      primary: "bg-default-inverted-300 text-default-inverted-900",
      secondary: "bg-default-200 text-default-800",
      destructive: "bg-accent-red-200 text-white",
      ghost: "bg-transparent text-default-800 hover:bg-default-200",
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
  {disabled}
  {title}
  aria-label={ariaLabel}
  {onclick}
  class="inline-flex items-center justify-center rounded-medium {sizeClass} {variantClass} hover:cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none {extraClass}"
>
  {#if icon}<i class="flex {icon} {size === 'sm' ? 'text-sm' : 'text-base'} shrink-0"></i>{/if}
  {@render children?.()}
</button>
