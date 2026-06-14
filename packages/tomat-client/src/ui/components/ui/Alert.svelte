<script lang="ts">
  import type { Snippet } from "svelte";
  import IconButton from "./IconButton.svelte";

  type Variant = "info" | "warning" | "error" | "success";
  type Size = "sm" | "md";
  type Surface = "filled" | "transparent";

  let {
    variant = "info",
    icon,
    size = "md",
    surface = "filled",
    align = "center",
    action,
    onclose,
    class: extraClass = "",
    children,
  }: {
    variant?: Variant;
    icon?: string | false;
    size?: Size;
    surface?: Surface;
    align?: "start" | "center";
    action?: { icon: string; title: string; onclick: () => void };
    onclose?: () => void;
    class?: string;
    children: Snippet;
  } = $props();

  const defaultIcon = $derived(
    {
      info: "i-material-symbols-info-outline-rounded",
      warning: "i-material-symbols-warning-outline-rounded",
      error: "i-material-symbols-error-outline-rounded",
      success: "i-material-symbols-check-circle-outline-rounded",
    }[variant],
  );

  const resolvedIcon = $derived(
    icon === false ? null : (icon ?? defaultIcon),
  );

  // Filled-surface color pairs. Full strings so the UnoCSS extractor sees
  // every variant.
  const filledClass = $derived(
    {
      info: "bg-surface-inset text-default-700",
      warning: "bg-accent-yellow-200 text-accent-yellow-700",
      error: "bg-accent-red-200 text-accent-red-700",
      success: "bg-accent-green-200 text-accent-green-700",
    }[variant],
  );

  // Transparent-surface palette: muted body text with an accent-coloured
  // icon. Matches the existing field-error row pattern in FieldCard.
  const iconAccentClass = $derived(
    {
      info: "text-default-500",
      warning: "text-accent-yellow-400",
      error: "text-accent-red-400",
      success: "text-accent-green-400",
    }[variant],
  );

  const surfaceClass = $derived(
    surface === "transparent"
      ? "text-default-700"
      : `${filledClass} rounded-medium`,
  );

  const sizeClass = $derived(
    size === "sm"
      ? "text-sm gap-1.5"
      : "text-sm gap-2",
  );

  const paddingClass = $derived(
    surface === "transparent" ? "" : size === "sm" ? "px-2 py-1" : "px-3 py-2",
  );

  const alignClass = $derived(align === "start" ? "items-start" : "items-center");
  const iconColorClass = $derived(
    surface === "transparent" ? iconAccentClass : "",
  );
  const iconSizeClass = $derived(size === "sm" ? "text-sm" : "text-base");
</script>

<div
  class="flex flex-row {alignClass} {sizeClass} {surfaceClass} {paddingClass} {extraClass}"
>
  {#if resolvedIcon}
    <i class="flex {resolvedIcon} {iconSizeClass} {iconColorClass} shrink-0"></i>
  {/if}
  <div class="flex-1 min-w-0">
    {@render children()}
  </div>
  {#if action}
    <IconButton
      icon={action.icon}
      title={action.title}
      onclick={action.onclick}
      size="sm"
      class="shrink-0"
    />
  {/if}
  {#if onclose}
    <IconButton
      icon="i-material-symbols-close-rounded"
      title="Dismiss"
      onclick={onclose}
      size="sm"
      class="shrink-0"
    />
  {/if}
</div>
