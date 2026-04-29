<script lang="ts">
  import type { SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import { settingsState } from "../../../state";
  import FieldDescription from "./FieldDescription.svelte";
  import FieldResetButton from "./FieldResetButton.svelte";

  let { field, error, onChange, onReset } = $props<{
    field: SettingField;
    error: string | null;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const currentValue = $derived(settingsState.currentSettings[field.id]);
  const isModified = $derived(currentValue !== field.defaultValue);
  const hasError = $derived(!!error);
</script>

<div
  class="flex flex-col gap-2 max-w-full overflow-clip px-4 pt-2 pb-3 text-base rounded-2xl border-2 {hasError
    ? 'bg-accent-red-100 border-accent-red-400'
    : 'bg-default-200 border-transparent'}"
>
  <div class="flex flex-row justify-between items-start gap-2">
    <div class="flex flex-col flex-1">
      <div class="text-default-800">{field.name}</div>
      {#if field.description}
        <FieldDescription text={field.description} />
      {/if}
    </div>
    {#if editable && isModified}
      <FieldResetButton onclick={() => onReset(field.id)} />
    {/if}
  </div>

  <textarea
    aria-label={field.name}
    class="multiline-scroll text-default-800 rounded-lg w-full px-2 py-1.5 outline-none min-h-40 overflow-y-hidden focus:overflow-y-auto whitespace-pre-wrap break-words text-sm {!editable
      ? 'opacity-60'
      : ''} {hasError
      ? 'bg-accent-red-300 border-accent-red-400'
      : 'bg-default-300 focus:ring-blue-500'}"
    disabled={!editable}
    placeholder={field.placeholder || ""}
    value={currentValue}
    oninput={(e) => onChange(field.id, (e.target as HTMLTextAreaElement).value)}
  ></textarea>

  {#if hasError}
    <div class="text-red-500 text-sm">{error}</div>
  {/if}
</div>

<style>
  .multiline-scroll::-webkit-scrollbar {
    width: 8px;
  }
  .multiline-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .multiline-scroll::-webkit-scrollbar-thumb {
    background: oklch(92.2% 0 0);
    border-radius: 4px;
  }
  .multiline-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.25);
  }
  :global(html.dark) .multiline-scroll::-webkit-scrollbar-thumb {
    background: oklch(30% 0 0);
  }
  :global(html.dark) .multiline-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
</style>
