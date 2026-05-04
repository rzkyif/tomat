<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import { settingsState } from "../../../state";
  import { expand } from "$lib/shared/animations";
  import FieldDescription from "./FieldDescription.svelte";

  let {
    field,
    error = null,
    horizontal = false,
    onReset,
    children,
  } = $props<{
    field: SettingField;
    error?: string | null;
    horizontal?: boolean;
    onReset?: (fieldId: string) => void;
    children: Snippet;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const currentValue = $derived(settingsState.currentSettings[field.id]);
  const isModified = $derived(currentValue !== field.defaultValue);
  const hasError = $derived(!!error);

  const effectiveTier = $derived(
    field.descriptionTier ?? (field.description ? "ondemand" : "none"),
  );
  let descriptionExpanded = $state(false);

  const showInfoButton = $derived(
    effectiveTier === "ondemand" && !!field.description,
  );
  const showResetButton = $derived(!!onReset && editable && isModified);
  const hasButtons = $derived(showInfoButton || showResetButton);
</script>

{#snippet resetButton()}
  <button
    class="text-default-500 hover:text-default-700 transition-colors flex items-center justify-center rounded-md"
    title="Reset to default"
    onclick={() => onReset?.(field.id)}
  >
    <i class="i-material-symbols-refresh-rounded text-lg flex"></i>
  </button>
{/snippet}

{#snippet infoButton()}
  <button
    class="transition-colors flex items-center justify-center rounded-md {descriptionExpanded
      ? 'text-default-900'
      : 'text-default-500 hover:text-default-700'}"
    title="Show description"
    onclick={() => (descriptionExpanded = !descriptionExpanded)}
    aria-pressed={descriptionExpanded}
  >
    <i class="i-material-symbols-info-outline-rounded text-lg flex"></i>
  </button>
{/snippet}

{#snippet buttonRow()}
  {#if horizontal}
    {#if showInfoButton}{@render infoButton()}{/if}
    {#if showResetButton}{@render resetButton()}{/if}
  {:else}
    {#if showResetButton}{@render resetButton()}{/if}
    {#if showInfoButton}{@render infoButton()}{/if}
  {/if}
{/snippet}

<div
  data-field-id={field.id}
  class="flex flex-col gap-2 max-w-full overflow-clip px-3 pt-1 pb-2 text-base rounded-2xl border-2 {hasError
    ? 'bg-accent-red-100 border-accent-red-400'
    : 'bg-default-200 border-transparent'}"
>
  <div
    class="flex {horizontal ? 'flex-row items-start gap-3' : 'flex-col gap-2'}"
  >
    <div class="flex flex-col flex-1 min-w-0 gap-1">
      {#if horizontal}
        {@const lastSpace = field.name.lastIndexOf(" ")}
        {@const head = lastSpace >= 0 ? field.name.slice(0, lastSpace + 1) : ""}
        {@const tail =
          lastSpace >= 0 ? field.name.slice(lastSpace + 1) : field.name}
        <div class="text-default-800 min-h-8 flex items-center">
          <div class="min-w-0">
            {head}<span class="whitespace-nowrap"
              >{tail}{#if hasButtons}<span
                  class="ml-1.5 inline-flex items-center gap-0.5 align-middle relative -top-px"
                  >{@render buttonRow()}</span
                >{/if}</span
            >
          </div>
        </div>
      {:else}
        <div class="flex flex-row items-center gap-2 min-h-8">
          <div class="flex-1 text-default-800 min-w-0">{field.name}</div>
          {#if hasButtons}
            <div class="flex items-center gap-1">
              {@render buttonRow()}
            </div>
          {/if}
        </div>
      {/if}
      {#if effectiveTier === "always" && field.description}
        <FieldDescription text={field.description} />
      {/if}
      {#if effectiveTier === "ondemand" && field.description && descriptionExpanded}
        <div transition:expand>
          <FieldDescription text={field.description} />
        </div>
      {/if}
    </div>

    <div class={horizontal ? "w-48 shrink-0" : ""}>
      {@render children()}
    </div>
  </div>

  {#if hasError}
    <div class="text-red-500 text-sm">{error}</div>
  {/if}
</div>
