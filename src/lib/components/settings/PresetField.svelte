<script lang="ts">
  import { settingsState } from "../../state";
  import type { SettingField, PresetOption } from "$lib/shared/settings";

  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  function presetBtnClass(
    color: string | undefined,
    selected: boolean,
  ): string {
    if (!selected) {
      if (color === "amber")
        return "bg-default-100 text-default-700 hover:bg-default-200";
      if (color === "purple")
        return "bg-default-100 text-default-700 hover:bg-default-200";
      return "bg-default-100 text-default-700 hover:bg-default-200";
    }
    if (color === "amber")
      return "bg-amber-500 text-white shadow-md shadow-amber-500/25";
    if (color === "purple")
      return "bg-purple-500 text-white shadow-md shadow-purple-500/25";
    return "bg-blue-500 text-white shadow-md shadow-blue-500/25";
  }
</script>

<div class="flex flex-col gap-2">
  {#if field.name}
    <div class="text-default-500 uppercase text-sm font-medium tracking-wide">
      {field.name}
    </div>
  {/if}
  {#if field.presetConfig}
    <div
      class="grid gap-1"
      style="grid-template-columns: repeat({field.presetConfig.columns}, 1fr)"
    >
      {#each field.presetConfig.options as opt}
        <button
          class="px-2 py-2.5 rounded-xl text-base font-medium cursor-pointer border-0.35em border-default-100 {presetBtnClass(
            opt.color,
            settingsState.currentSettings[field.id] === opt.id,
          )}"
          onclick={() => onPresetSelect(field.id, opt)}
        >
          {#if opt.icon}<i
              class="{opt.icon} inline-block align-middle mr-1 text-lg"
            ></i>{/if}
          {opt.label}
        </button>
      {/each}
    </div>
    {#if field.presetConfig.secondaryOptions}
      <div class="grid grid-cols-2 gap-1">
        {#each field.presetConfig.secondaryOptions as opt}
          <button
            class="px-3 py-2.5 rounded-xl text-base font-medium cursor-pointer border-0.35em border-default-100 {presetBtnClass(
              opt.color,
              settingsState.currentSettings[field.id] === opt.id,
            )}"
            onclick={() => onPresetSelect(field.id, opt)}
          >
            {#if opt.icon}<i
                class="{opt.icon} inline-block align-middle mr-1 text-lg"
              ></i>{/if}
            {opt.label}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
