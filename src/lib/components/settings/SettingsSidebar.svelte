<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { SETTINGS_SCHEMA } from "$lib/shared/settings";
  import type { ServerStatusUpdate } from "$lib/shared/types";
  import ServerStatusChip from "./ServerStatusChip.svelte";

  let {
    selectedGroupId = $bindable(),
    onSelect,
    llmStatus,
    sttStatus,
    bunStatus,
  } = $props<{
    selectedGroupId: string;
    onSelect?: (id: string) => void;
    llmStatus: ServerStatusUpdate;
    sttStatus: ServerStatusUpdate;
    bunStatus: ServerStatusUpdate;
  }>();

  let version = $state("");
  onMount(async () => {
    try {
      version = await getVersion();
    } catch {
      version = "";
    }
  });
</script>

<div class="flex flex-col gap-2 overflow-y-auto justify-between">
  <div class="flex flex-col gap-1">
    {#each SETTINGS_SCHEMA as group}
      <button
        class="text-left text-base hover:cursor-pointer pl-3 border-l-4 transition-colors {selectedGroupId ===
        group.id
          ? ''
          : ''} {selectedGroupId === group.id
          ? 'text-default-900 border-default-700'
          : 'text-default-500 border-transparent hover:text-default-700 hover:border-default-500'}"
        onclick={() => {
          selectedGroupId = group.id;
          onSelect?.(group.id);
        }}
      >
        {group.name}
      </button>
    {/each}
  </div>

  <div class="flex flex-col gap-2 w-fit">
    <div class="flex flex-col gap-1 text-sm font-medium w-fit">
      <ServerStatusChip type="LLM" update={llmStatus} />
      <ServerStatusChip type="STT" update={sttStatus} />
      <ServerStatusChip type="Bun" update={bunStatus} />
    </div>
    <div
      class="flex items-center gap-1.5 text-default-600 text-sm pb-2 select-none"
    >
      <img src="/tomat.png" alt="tomat" class="w-6 h-6" />
      <span>{version ? `v${version}` : ""}</span>
    </div>
  </div>
</div>
