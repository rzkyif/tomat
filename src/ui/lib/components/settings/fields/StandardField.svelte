<script lang="ts">
  import type { SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import { settingsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let {
    field,
    monitors,
    error,
    horizontal = false,
    onChange,
    onReset,
  } = $props<{
    field: SettingField;
    monitors: Monitor[];
    error: string | null;
    horizontal?: boolean;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const hasError = $derived(!!error);

  const inputType = $derived(
    field.type === "password"
      ? "password"
      : field.type === "number" || field.type === "float"
        ? "number"
        : "text",
  );
  const isNumeric = $derived(field.type === "number" || field.type === "float");
  const numericStep = $derived(field.type === "float" ? 0.1 : 1);

  function adjustNumeric(direction: 1 | -1) {
    if (!editable) return;
    const current = settingsState.currentSettings[field.id];
    const base =
      typeof current === "number" && !Number.isNaN(current) ? current : 0;
    const next = base + direction * numericStep;
    // Avoid float artifacts (0.1 + 0.2 = 0.300...4) for the float case.
    const value = field.type === "float" ? Math.round(next * 10) / 10 : next;
    onChange(field.id, value);
  }
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  {#if field.type === "boolean"}
    <label
      class="relative flex items-center cursor-pointer w-full {!editable
        ? 'opacity-60 pointer-events-none'
        : ''}"
    >
      <input
        type="checkbox"
        aria-label={field.name}
        class="sr-only peer"
        checked={settingsState.currentSettings[field.id]}
        disabled={!editable}
        onchange={(e) =>
          onChange(field.id, (e.target as HTMLInputElement).checked)}
      />
      <div
        class="w-full h-2em relative bg-default-300 peer-focus:outline-none rounded-medium peer peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:after:content-['on'] after:content-['off'] after:text-center after:text-xs after:content-center after:uppercase after:absolute after:top-0.25em after:left-0.25em after:bg-default-200 after:text-default-500 after:rounded-medium after:h-2.16em after:w-[calc(50%-0.25em)] after:transition-all peer-checked:bg-default-400"
      ></div>
    </label>
  {:else if field.type === "select" || field.type === "monitor"}
    {@const selectValue =
      field.type === "monitor"
        ? settingsState.getMonitor()
        : settingsState.currentSettings[field.id]}
    <div class="relative w-full">
      <select
        aria-label={field.name}
        class="appearance-none bg-default-300 text-default-800 rounded-medium focus:ring-blue-500 focus:border-blue-500 block w-full h-8 px-2 pr-7 outline-none {!editable
          ? 'opacity-60'
          : ''}"
        disabled={!editable}
        value={selectValue}
        onchange={(e) =>
          onChange(field.id, (e.target as HTMLSelectElement).value)}
      >
        {#if field.type === "monitor"}
          <option value="primary">Primary Monitor</option>
          {#each monitors as monitor}
            <option value={monitor.id.toString()}>{monitor.name}</option>
          {/each}
        {:else}
          {#each field.options || [] as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        {/if}
      </select>
      <i
        class="i-material-symbols-expand-more-rounded absolute right-1.5 top-1/2 -translate-y-1/2 text-default-600 pointer-events-none"
      ></i>
    </div>
  {:else}
    <div class="flex flex-row items-center gap-2 w-full">
      <div class="relative flex-1 min-w-0">
        <input
          aria-label={field.name}
          type={inputType}
          step={field.type === "float"
            ? "0.1"
            : field.type === "number"
              ? "1"
              : undefined}
          class="text-default-800 rounded-medium block w-full min-h-8 px-2 outline-none {isNumeric
            ? 'no-spinner pr-7'
            : ''} {!editable ? 'opacity-60' : ''} {hasError
            ? 'bg-accent-red-300 border-accent-red-400'
            : 'bg-default-300 focus:ring-blue-500'}"
          disabled={!editable}
          placeholder={field.placeholder || ""}
          value={settingsState.currentSettings[field.id]}
          onchange={(e) => {
            const val = (e.target as HTMLInputElement).value;
            if (isNumeric) {
              onChange(
                field.id,
                field.type === "float" ? parseFloat(val) : parseInt(val, 10),
              );
            } else {
              onChange(field.id, val);
            }
          }}
        />
        {#if isNumeric}
          <div class="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col">
            <button
              type="button"
              tabindex="-1"
              aria-label="Increase {field.name}"
              class="text-default-500 hover:text-default-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center h-3.5 w-5"
              disabled={!editable}
              onclick={() => adjustNumeric(1)}
            >
              <i
                class="i-material-symbols-keyboard-arrow-up-rounded text-base flex"
              ></i>
            </button>
            <button
              type="button"
              tabindex="-1"
              aria-label="Decrease {field.name}"
              class="text-default-500 hover:text-default-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center h-3.5 w-5"
              disabled={!editable}
              onclick={() => adjustNumeric(-1)}
            >
              <i
                class="i-material-symbols-keyboard-arrow-down-rounded text-base flex"
              ></i>
            </button>
          </div>
        {/if}
      </div>
      {#if field.suffix}
        <span class="text-default-500 text-sm shrink-0">{field.suffix}</span>
      {/if}
    </div>
  {/if}
</FieldCard>

<style>
  /* Hide native spin buttons on number inputs so the themed chevron
     buttons above can replace them. Same approach as NumberSliderField. */
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
