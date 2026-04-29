<script lang="ts">
  import { settingsState } from "../../state";
  import type { SettingSection, PresetOption } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import { evalCondition } from "$lib/shared/settings";
  import SettingsField from "./SettingsField.svelte";

  let {
    section,
    sectionKey,
    isExpanded,
    monitors,
    validationErrors,
    onToggle,
    onChange,
    onReset,
    onPresetSelect,
  } = $props<{
    section: SettingSection;
    sectionKey: string;
    isExpanded: boolean;
    monitors: Monitor[];
    validationErrors: Record<string, string>;
    onToggle: (key: string) => void;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const isVisible = $derived(
    evalCondition(section.visibleWhen, settingsState.currentSettings),
  );
</script>

{#if isVisible}
  <div class="flex flex-col gap-2">
    {#if section.collapsible}
      <button
        class="flex items-center gap-2 text-sm text-default-500 font-medium uppercase tracking-wide cursor-pointer hover:text-default-700 transition-colors w-fit"
        onclick={() => onToggle(sectionKey)}
      >
        <i
          class="inline-block transition-transform duration-200 {isExpanded
            ? 'i-material-symbols-expand-more-rounded'
            : 'i-material-symbols-chevron-right-rounded'}"
        ></i>
        {section.label}
      </button>
      {#if isExpanded}
        <div class="flex flex-col gap-2">
          {#each section.fields as field}
            <SettingsField
              {field}
              {monitors}
              error={validationErrors[field.id]}
              {onChange}
              {onReset}
              {onPresetSelect}
            />
          {/each}
        </div>
      {/if}
    {:else}
      {#if section.label}
        <div
          class="text-sm text-default-500 font-medium uppercase tracking-wide"
        >
          {section.label}
        </div>
      {/if}
      <div class="flex flex-col gap-2">
        {#each section.fields as field}
          <SettingsField
            {field}
            {monitors}
            error={validationErrors[field.id]}
            {onChange}
            {onReset}
            {onPresetSelect}
          />
        {/each}
      </div>
    {/if}
  </div>
{/if}
