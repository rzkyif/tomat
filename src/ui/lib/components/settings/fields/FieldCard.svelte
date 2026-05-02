<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import { settingsState } from "../../../state";
  import { expand } from "$lib/shared/animations";
  import FieldDescription from "./FieldDescription.svelte";

  let {
    field,
    error,
    horizontal = false,
    onReset,
    children,
  } = $props<{
    field: SettingField;
    error: string | null;
    horizontal?: boolean;
    onReset: (fieldId: string) => void;
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
  const showResetButton = $derived(editable && isModified);
  const hasButtons = $derived(showInfoButton || showResetButton);
</script>

{#snippet buttonRow()}
  {#if showResetButton}
    <button
      class="text-default-500 hover:text-default-700 transition-colors flex items-center justify-center rounded-md"
      title="Reset to default"
      onclick={() => onReset(field.id)}
    >
      <i class="i-material-symbols-refresh-rounded text-lg flex"></i>
    </button>
  {/if}
  {#if showInfoButton}
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
  {/if}
{/snippet}

<div
  data-field-id={field.id}
  class="flex flex-col gap-2 max-w-full overflow-clip px-3 py-2 text-base rounded-2xl border-2 {hasError
    ? 'bg-accent-red-100 border-accent-red-400'
    : 'bg-default-200 border-transparent'}"
>
  <div
    class="flex {horizontal ? 'flex-row items-start gap-3' : 'flex-col gap-2'}"
  >
    <div class="flex flex-col flex-1 min-w-0 gap-1">
      <div class="flex flex-row items-center gap-2">
        <div class="flex-1 text-default-800 min-w-0">{field.name}</div>
        {#if !horizontal && hasButtons}
          {@render buttonRow()}
        {/if}
      </div>
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

  {#if horizontal && hasButtons}
    <div class="flex flex-row justify-end items-center gap-1 -mt-1">
      {@render buttonRow()}
    </div>
  {/if}
</div>
