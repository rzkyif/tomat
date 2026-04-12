<script lang="ts">
  import { settingsState } from "../../state";
  import type { SettingField, PresetOption } from "$lib/shared/settings";

  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  function presetBtnClass(selected: boolean): string {
    return selected
      ? "bg-blue-500 text-white shadow-md shadow-blue-500/25"
      : "bg-default-100 text-default-700 hover:bg-default-200";
  }
</script>

<div class="flex flex-col gap-2">
  {#if field.name}
    <div class="text-default-500 uppercase text-sm font-medium tracking-wide">
      {field.name}
    </div>
  {/if}
  {#if field.presetConfig}
    <div class="flex flex-col gap-2">
      {#each field.presetConfig.options as opt}
        {@const selected = settingsState.currentSettings[field.id] === opt.id}
        <button
          type="button"
          class="p-3 rounded-xl cursor-pointer border-0.35em border-default-100 text-left flex flex-col gap-1.5 {presetBtnClass(
            selected,
          )}"
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
                ? 'opacity-90'
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
            <div
              class="text-sm leading-snug whitespace-pre-line {selected
                ? 'opacity-90'
                : 'text-default-500'}"
            >
              {opt.description}
            </div>
          {/if}
        </button>
      {/each}
    </div>
    {#if field.presetConfig.secondaryOptions}
      <div class="flex flex-col gap-2">
        {#each field.presetConfig.secondaryOptions as opt}
          {@const selected = settingsState.currentSettings[field.id] === opt.id}
          <button
            type="button"
            class="p-3 rounded-xl cursor-pointer border-0.35em border-default-100 text-left flex flex-col gap-1.5 {presetBtnClass(
              selected,
            )}"
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
                  ? 'opacity-90'
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
              <div
                class="text-sm leading-snug whitespace-pre-line {selected
                  ? 'opacity-90'
                  : 'text-default-500'}"
              >
                {opt.description}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
