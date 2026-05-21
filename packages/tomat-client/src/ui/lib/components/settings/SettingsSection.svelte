<script lang="ts">
  import { settingsState } from "../../state";
  import type { SettingSection, PresetOption } from "@tomat/shared";
  import type { Monitor } from "$lib/shared/types";
  import { evalCondition } from "@tomat/shared";
  import SettingsField from "./SettingsField.svelte";

  let {
    section,
    sectionKey,
    isExpanded,
    monitors,
    fonts,
    validationErrors,
    horizontal = false,
    onToggle,
    onChange,
    onReset,
    onPresetSelect,
  } = $props<{
    section: SettingSection;
    sectionKey: string;
    isExpanded: boolean;
    monitors: Monitor[];
    fonts: string[];
    validationErrors: Record<string, string>;
    horizontal?: boolean;
    onToggle: (key: string) => void;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const isVisible = $derived(
    evalCondition(section.visibleWhen, settingsState.currentSettings),
  );

  const showAdvanced = $derived(
    !!settingsState.currentSettings["appearance.settings.showAdvanced"],
  );

  const sectionAdvancedHidden = $derived(!!section.advanced && !showAdvanced);

  const visibleFields = $derived(
    section.fields.filter((f: any) => showAdvanced || !f.advanced),
  );
</script>

{#if isVisible && !sectionAdvancedHidden && visibleFields.length > 0}
  <div data-section-key={sectionKey} class="flex flex-col gap-2">
    {#if section.label}
      <div class="sticky top-7 z-10">
        {#if section.collapsible}
          <button
            class="flex items-center gap-2 h-7 bg-default-300 text-sm text-default-500 font-medium uppercase tracking-wide cursor-pointer hover:text-default-700 transition-colors w-full"
            onclick={() => onToggle(sectionKey)}
          >
            <i
              class="inline-block transition-transform duration-200 {isExpanded
                ? 'i-material-symbols-expand-more-rounded'
                : 'i-material-symbols-chevron-right-rounded'}"
            ></i>
            {section.label}
          </button>
        {:else}
          <div
            class="flex items-center h-7 bg-default-300 text-sm text-default-500 font-medium uppercase tracking-wide"
          >
            {section.label}
          </div>
        {/if}
        <div
          class="absolute left-0 right-0 top-full h-3 bg-gradient-to-b from-default-300 to-transparent pointer-events-none"
        ></div>
      </div>
    {/if}
    {#if !section.collapsible || isExpanded}
      <div class="flex flex-col gap-1">
        {#each visibleFields as field}
          <SettingsField
            {field}
            {monitors}
            {fonts}
            error={validationErrors[field.id]}
            {horizontal}
            {onChange}
            {onReset}
            {onPresetSelect}
          />
        {/each}
      </div>
    {/if}
  </div>
{/if}
