<script lang="ts">
  import { settingsState } from "../../state";
  import type { SettingSection, PresetOption } from "@tomat/shared";
  import type { Monitor } from "$lib/shared/types";
  import { evalCondition } from "@tomat/shared";
  import SettingsField from "./SettingsField.svelte";
  import SectionHeader from "../ui/SectionHeader.svelte";

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
        <SectionHeader
          label={section.label}
          level="section"
          collapsible={section.collapsible}
          expanded={isExpanded}
          onToggle={() => onToggle(sectionKey)}
        />
      </div>
    {/if}
    {#if !section.collapsible || isExpanded}
      <div class="flex flex-col gap-1">
        {#each visibleFields as field (field.id)}
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
