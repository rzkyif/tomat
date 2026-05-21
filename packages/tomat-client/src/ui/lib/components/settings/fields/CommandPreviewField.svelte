<script lang="ts">
  import { settingsState } from "../../../state";
  import { buildPreview, getCommandSettingIds } from "$lib/shared/command";
  import type { CommandType } from "$lib/shared/command";
  import type { SettingField } from "@tomat/shared";
  import FieldCard from "./FieldCard.svelte";

  let { field } = $props<{
    field: SettingField;
  }>();

  const previewPromise = $derived.by(() => {
    const type = field.commandType as CommandType | undefined;
    if (!type) return Promise.resolve("");

    const values: Record<string, any> = {};
    for (const id of getCommandSettingIds(type)) {
      values[id] = settingsState.currentSettings[id];
    }

    return buildPreview(type, values);
  });
</script>

{#if field.commandType}
  <FieldCard {field}>
    <div class="overflow-hidden rounded-medium bg-default-300">
      <div class="overflow-x-auto overflow-y-clip">
        <pre class="flex leading-relaxed m-0"><code
            class="overflow-clip text-sm font-mono bg-transparent p-3 text-default-800 whitespace-pre"
            >{#await previewPromise}Loading...{:then preview}{preview}{/await}</code
          ></pre>
      </div>
    </div>
  </FieldCard>
{/if}
