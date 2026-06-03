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

  // Every labeled section is collapsible; the label row is the toggle.
  // Unlabeled sections have no header, so they always render inline.
  const collapsible = $derived(!!section.label);

  // A collapsed section is just its header row. The container's gap-3 is sized
  // for the space below an expanded section's last field, so stacked between
  // bare headers it reads as too airy; pull the next section up with a negative
  // bottom margin. Only the gap after a collapsed section tightens: header to
  // first field, field to field, and last field to next section keep full gap.
  const isCollapsed = $derived(collapsible && !isExpanded);
</script>

{#if isVisible && section.fields.length > 0}
  <!-- gap-1: the header hugs its own fields (same spacing as field-to-field).
       Separation BETWEEN sections comes from the container gap in Settings,
       so a section reads as one unit with clear space before the next. -->
  <div
    data-section-key={sectionKey}
    class="flex flex-col gap-1 {isCollapsed ? '-mb-2' : ''}"
  >
    {#if section.label}
      <div class="sticky top-7 z-10 pt-1.5 bg-surface">
        <SectionHeader
          label={section.label}
          level="section"
          {collapsible}
          expanded={isExpanded}
          onToggle={() => onToggle(sectionKey)}
        />
      </div>
    {/if}
    {#if !collapsible || isExpanded}
      <!-- Labeled (collapsible) sections indent their fields so the column's
           left edge lines up with the header label text: chevron (1em) + the
           header's gap-1 (0.25rem) = 1.25rem = pl-5. Unlabeled sections render
           flush. Both units scale with appearance.textSize. -->
      <div class="flex flex-col gap-1" class:pl-5={collapsible}>
        {#each section.fields as field (field.id)}
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
