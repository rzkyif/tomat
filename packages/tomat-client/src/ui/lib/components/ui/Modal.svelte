<script lang="ts">
  import type { Snippet } from "svelte";

  type MaxWidth = "sm" | "md" | "lg" | "xl" | "fit";
  type Positioning = "absolute" | "fixed";
  type Surface = "default" | "transparent";

  let {
    open,
    onclose,
    maxWidth = "md",
    positioning = "absolute",
    surface = "default",
    dismissOnBackdrop = true,
    dismissOnEsc = true,
    ariaLabel,
    class: extraClass = "",
    children,
  }: {
    open: boolean;
    onclose: () => void;
    maxWidth?: MaxWidth;
    positioning?: Positioning;
    surface?: Surface;
    dismissOnBackdrop?: boolean;
    dismissOnEsc?: boolean;
    ariaLabel?: string;
    class?: string;
    children: Snippet;
  } = $props();

  const maxWidthClass = $derived(
    {
      sm: "max-w-sm",
      md: "max-w-md",
      lg: "max-w-lg",
      xl: "max-w-xl",
      fit: "",
    }[maxWidth],
  );

  const sizeClass = $derived(
    maxWidth === "fit"
      ? "w-fit"
      : `w-[calc(100%-2rem)] ${maxWidthClass}`,
  );

  const positioningClass = $derived(
    positioning === "fixed" ? "fixed pointer-events-auto" : "absolute",
  );

  const surfaceClass = $derived(
    surface === "transparent" ? "" : "bg-surface rounded-large p-5 shadow-xl",
  );

  $effect(() => {
    if (!open || !dismissOnEsc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="{positioningClass} inset-0 flex items-center justify-center z-50 rounded-large"
    onpointerdown={dismissOnBackdrop ? onclose : undefined}
  >
    <!-- Blur+dim lives on its OWN layer behind the dialog, never as the dialog's
         parent. WebKit folds a backdrop-filter element's compositing-layer
         children (e.g. a scroll container) into the filtered region, which would
         blur the dialog's own content. Keeping this layer childless and the
         dialog a separate sibling above it avoids that. -->
    <div
      class="absolute inset-0 bg-black/20 backdrop-blur rounded-large pointer-events-none"
      aria-hidden="true"
    ></div>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- Dismiss on pointerdown OUTSIDE only (not click): a press that starts
         inside the dialog (e.g. dragging a slider) and releases on the backdrop
         must not close it. Stopping pointerdown here keeps inside-presses from
         reaching the backdrop. -->
    <div
      class="relative {surfaceClass} {sizeClass} flex flex-col gap-3 {extraClass}"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabindex={-1}
      onpointerdown={(e) => e.stopPropagation()}
    >
      {@render children()}
    </div>
  </div>
{/if}
