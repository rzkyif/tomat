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
        class="w-full h-8 relative bg-default-300 peer-focus:outline-none rounded-lg peer peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:after:content-['on'] after:content-['off'] after:text-center after:text-xs after:content-center after:uppercase after:absolute after:top-0.35em after:left-0.35em after:bg-default-200 after:text-default-900 after:rounded-lg after:h-1.85em after:w-[calc(50%-0.35em)] after:transition-all peer-checked:bg-neutral-200"
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
        class="appearance-none bg-default-300 text-default-800 rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full h-8 px-2 pr-7 outline-none {!editable
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
      <input
        aria-label={field.name}
        type={inputType}
        step={field.type === "float"
          ? "0.1"
          : field.type === "number"
            ? "1"
            : undefined}
        class="text-default-800 rounded-lg block w-full min-h-8 px-2 outline-none {!editable
          ? 'opacity-60'
          : ''} {hasError
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
      {#if field.suffix}
        <span class="text-default-500 text-sm shrink-0">{field.suffix}</span>
      {/if}
    </div>
  {/if}
</FieldCard>
