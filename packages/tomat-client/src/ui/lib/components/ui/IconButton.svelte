<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Size = "xs" | "sm" | "md" | "lg" | "lg-tight";
  type Variant = "default" | "subtle";
  type Surface = "none" | "filled" | "circle";

  type Props = Omit<
    HTMLButtonAttributes,
    "class" | "type" | "disabled" | "onclick" | "title" | "aria-label"
  > & {
    /** Icon class string (e.g. "i-material-symbols-add-rounded") or a
     *  snippet for arbitrary inner content (custom SVG, animated indicator,
     *  conditional icon trees, etc.). */
    icon: string | Snippet;
    title: string;
    ariaLabel?: string;
    size?: Size;
    variant?: Variant;
    surface?: Surface;
    active?: boolean;
    /** Override the text-color classes entirely (e.g. an accent-yellow ping).
     *  When set, replaces the variant's default color logic. */
    colorClass?: string;
    disabled?: boolean;
    type?: "button" | "submit";
    onclick?: (e: MouseEvent) => void;
    badge?: Snippet;
    class?: string;
  };

  let {
    icon,
    title,
    ariaLabel,
    size = "md",
    variant = "default",
    surface = "none",
    active = false,
    colorClass,
    disabled = false,
    type = "button",
    onclick,
    badge,
    class: extraClass = "",
    ...rest
  }: Props = $props();

  const sizeClass = $derived(
    {
      xs: "w-5 h-5 text-sm",
      sm: "p-0.5 text-lg",
      md: "p-1 text-lg",
      lg: "p-2 text-xl",
      // Same lg icon (text-xl) but half the padding, for buttons packed into a
      // ButtonGroup-style pill that carries the other half as its own padding.
      "lg-tight": "p-1 text-xl",
    }[size],
  );

  const variantClass = $derived(
    colorClass ??
      (variant === "subtle"
        ? active
          ? "text-default-700"
          : "text-default-400 hover:text-default-700"
        : active
          ? "text-default-900"
          : "text-default-700 hover:text-default-900"),
  );

  const surfaceClass = $derived(
    {
      none: "rounded",
      filled: "bg-surface-inset rounded-medium",
      circle: "bg-surface-inset rounded-full",
    }[surface],
  );
</script>

<button
  {...rest}
  {type}
  {disabled}
  {title}
  aria-label={ariaLabel ?? title}
  {onclick}
  class="flex items-center justify-center shrink-0 {sizeClass} {variantClass} {surfaceClass} hover:cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none {extraClass}"
>
  {#if badge}
    <span class="relative flex shrink-0">
      {#if typeof icon === "string"}
        <i class="flex {icon}"></i>
      {:else}
        {@render icon()}
      {/if}
      {@render badge()}
    </span>
  {:else if typeof icon === "string"}
    <i class="flex {icon}"></i>
  {:else}
    {@render icon()}
  {/if}
</button>
