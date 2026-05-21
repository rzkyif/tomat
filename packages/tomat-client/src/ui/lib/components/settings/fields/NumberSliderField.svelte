<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let {
    field,
    error,
    horizontal = false,
    onChange,
    onReset,
  } = $props<{
    field: SettingField;
    error: string | null;
    horizontal?: boolean;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const hasError = $derived(!!error);

  const min = $derived(field.min ?? 0);
  const max = $derived(field.max ?? 100);
  const step = $derived(field.step ?? 1);

  const value = $derived(
    Number(settingsState.currentSettings[field.id] ?? field.defaultValue ?? 0),
  );

  function commit(raw: string | number) {
    const n = typeof raw === "number" ? raw : parseFloat(raw);
    if (Number.isNaN(n)) return;
    const clamped = Math.max(min, Math.min(max, n));
    onChange(field.id, clamped);
  }
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  <div
    class="flex flex-row items-center gap-3 w-full {!editable
      ? 'opacity-60 pointer-events-none'
      : ''}"
  >
    <input
      type="range"
      aria-label="{field.name} slider"
      class="flex-1 min-w-0"
      {min}
      {max}
      {step}
      {value}
      disabled={!editable}
      oninput={(e) => commit((e.target as HTMLInputElement).value)}
    />
    <input
      type="number"
      aria-label={field.name}
      class="no-spinner text-default-800 rounded-medium block w-16 shrink-0 min-h-8 px-2 outline-none {hasError
        ? 'bg-accent-red-300 border-accent-red-400'
        : 'bg-default-300 focus:ring-blue-500'}"
      {min}
      {max}
      {step}
      {value}
      disabled={!editable}
      onchange={(e) => commit((e.target as HTMLInputElement).value)}
    />
    {#if field.suffix}
      <span class="text-default-500 text-sm shrink-0">{field.suffix}</span>
    {/if}
  </div>
</FieldCard>

<style>
  /* Override the global slider track color (which assumes a `bg-default-300`
     surface, like ColorPickerModal). FieldCard sits on `bg-default-200`, so
     we shift the track one step further along the lightness scale to keep
     it visible: lighter in light mode (`--default-100`), darker in dark mode
     (`--default-d-100`). The thumb stays at the global `--default-500` /
     `--default-d-500` since it has plenty of contrast on either surface. */
  input[type="range"]::-webkit-slider-runnable-track {
    background: var(--default-100);
  }
  :global(.dark) input[type="range"]::-webkit-slider-runnable-track {
    background: var(--default-d-100);
  }
  input[type="range"]::-moz-range-track {
    background: var(--default-100);
  }
  :global(.dark) input[type="range"]::-moz-range-track {
    background: var(--default-d-100);
  }
  .no-spinner::-webkit-inner-spin-button,
  .no-spinner::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .no-spinner {
    -moz-appearance: textfield;
    appearance: textfield;
  }
</style>
