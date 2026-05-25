<script lang="ts">
  import type { Snippet } from "svelte";
  import Expand from "./Expand.svelte";
  import HelpText from "./HelpText.svelte";
  import IconButton from "./IconButton.svelte";
  import Alert from "./Alert.svelte";

  type DescriptionTier = "always" | "ondemand" | "none";

  let {
    label,
    description,
    descriptionTier,
    horizontal = false,
    error = null,
    onReset,
    showReset,
    controlWidth = "w-48",
    fieldId,
    class: extraClass = "",
    children,
  }: {
    label: string;
    description?: string;
    descriptionTier?: DescriptionTier;
    horizontal?: boolean;
    error?: string | null;
    onReset?: () => void;
    showReset?: boolean;
    controlWidth?: string;
    fieldId?: string;
    class?: string;
    children: Snippet;
  } = $props();

  const effectiveTier: DescriptionTier = $derived(
    descriptionTier ?? (description ? "ondemand" : "none"),
  );
  let descriptionExpanded = $state(false);

  const showInfoButton = $derived(
    effectiveTier === "ondemand" && !!description,
  );
  const showResetButton = $derived(showReset === undefined ? !!onReset : showReset);
  const hasButtons = $derived(showInfoButton || showResetButton);
  const hasError = $derived(!!error);
</script>

{#snippet buttons()}
  {#if horizontal}
    {#if showInfoButton}
      <IconButton
        icon="i-material-symbols-info-outline-rounded"
        title="Show description"
        size="sm"
        variant="subtle"
        active={descriptionExpanded}
        onclick={() => (descriptionExpanded = !descriptionExpanded)}
        aria-pressed={descriptionExpanded}
      />
    {/if}
    {#if showResetButton}
      <IconButton
        icon="i-material-symbols-refresh-rounded"
        title="Reset to default"
        size="sm"
        variant="subtle"
        onclick={() => onReset?.()}
      />
    {/if}
  {:else}
    {#if showResetButton}
      <IconButton
        icon="i-material-symbols-refresh-rounded"
        title="Reset to default"
        size="sm"
        variant="subtle"
        onclick={() => onReset?.()}
      />
    {/if}
    {#if showInfoButton}
      <IconButton
        icon="i-material-symbols-info-outline-rounded"
        title="Show description"
        size="sm"
        variant="subtle"
        active={descriptionExpanded}
        onclick={() => (descriptionExpanded = !descriptionExpanded)}
        aria-pressed={descriptionExpanded}
      />
    {/if}
  {/if}
{/snippet}

<div
  data-field-id={fieldId}
  class="flex flex-col gap-2 max-w-full overflow-clip px-3 pt-1 {horizontal
    ? 'pb-1'
    : 'pb-2'} text-base rounded-medium bg-default-200 {extraClass}"
>
  <div class="flex {horizontal ? 'flex-row items-center gap-3' : 'flex-col gap-1'}">
    <div class="flex flex-col flex-1 min-w-0 gap-1">
      {#if horizontal}
        <!-- Smart line-break: keep the last word of the label glued to the
             inline buttons so the buttons never wrap to the next line alone. -->
        {@const lastSpace = label.lastIndexOf(" ")}
        {@const head = lastSpace >= 0 ? label.slice(0, lastSpace + 1) : ""}
        {@const tail = lastSpace >= 0 ? label.slice(lastSpace + 1) : label}
        <div class="text-default-800 min-h-8 flex items-center">
          <div class="min-w-0">
            {head}<span class="whitespace-nowrap"
              >{tail}{#if hasButtons}<span
                  class="ml-1.5 inline-flex items-center gap-0.5 align-middle relative -top-px"
                  >{@render buttons()}</span
                >{/if}</span
            >
          </div>
        </div>
      {:else}
        <div class="flex flex-row items-center gap-2 min-h-8">
          <div class="flex-1 text-default-800 min-w-0">{label}</div>
          {#if hasButtons}
            <div class="flex items-center gap-1">
              {@render buttons()}
            </div>
          {/if}
        </div>
      {/if}
      {#if effectiveTier === "always" && description}
        <HelpText text={description} />
      {/if}
      {#if effectiveTier === "ondemand" && description}
        <Expand open={descriptionExpanded}>
          <HelpText text={description} />
        </Expand>
      {/if}
    </div>

    <div class={horizontal ? `${controlWidth} shrink-0 flex flex-col gap-1` : ""}>
      {@render children()}
      {#if horizontal && hasError && error}
        <Alert variant="error" surface="transparent" size="sm">{error}</Alert>
      {/if}
    </div>
  </div>

  {#if !horizontal && hasError && error}
    <Alert variant="error" surface="transparent" size="sm">{error}</Alert>
  {/if}
</div>
