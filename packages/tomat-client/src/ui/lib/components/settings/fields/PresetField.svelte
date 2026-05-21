<script lang="ts">
  import { settingsState } from "../../../state";
  import type { SettingField, PresetOption } from "@tomat/shared";
  import FieldCard from "./FieldCard.svelte";
  import FieldDescription from "./FieldDescription.svelte";

  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  // Selected vs. unselected styling: selection fully inverts bg/text.
  // Hover just bumps the bg one shade lighter as a subtle highlight; text
  // stays put.
  const unselectedClasses = "bg-default-300 text-default-800";
  const selectedClasses = "bg-default-inverted-300 text-default-inverted-800";
</script>

{#snippet presetButton(opt: PresetOption)}
  {@const selected = settingsState.currentSettings[field.id] === opt.id}
  <button
    type="button"
    class="p-3 rounded-large cursor-pointer text-left flex flex-col gap-1.5 outline-none transition-colors duration-100 {selected
      ? selectedClasses
      : unselectedClasses}"
    onclick={() => onPresetSelect(field.id, opt)}
  >
    <div class="flex items-center gap-1.5">
      {#if opt.icon}
        <i class="{opt.icon} text-lg"></i>
      {/if}
      <span class="text-base font-semibold leading-tight">
        {opt.title ?? opt.label}
      </span>
    </div>
    {#if opt.badges && opt.badges.length > 0}
      <div
        class="flex flex-wrap gap-x-3 gap-y-1 text-xs {selected
          ? 'text-default-inverted-600'
          : 'text-default-600'}"
      >
        {#each opt.badges as badge}
          <span class="inline-flex items-center gap-1">
            <i class="{badge.icon} text-sm"></i>
            <span>{badge.label}</span>
          </span>
        {/each}
      </div>
    {/if}
    {#if opt.description}
      <FieldDescription
        text={opt.description}
        variant="preset"
        class={selected ? "text-default-inverted-500" : "text-default-500"}
      />
    {/if}
  </button>
{/snippet}

<FieldCard {field}>
  {#if field.presetConfig}
    <div class="flex flex-col gap-2">
      {#each field.presetConfig.options as opt}
        {@render presetButton(opt)}
      {/each}
    </div>
    {#if field.presetConfig.secondaryOptions}
      <div class="flex flex-col gap-2 pt-2">
        {#each field.presetConfig.secondaryOptions as opt}
          {@render presetButton(opt)}
        {/each}
      </div>
    {/if}
  {/if}
</FieldCard>
