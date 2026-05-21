<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import { serversState, settingsState } from "../../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import FieldCard from "./FieldCard.svelte";

  let { field, horizontal: _horizontal = false } = $props<{
    field: SettingField;
    horizontal?: boolean;
  }>();

  type ServiceKey = "llama" | "whisper" | "tts" | "tool";
  const SERVICES: Array<{ key: ServiceKey }> = [
    { key: "llama" },
    { key: "whisper" },
    { key: "tts" },
    { key: "tool" },
  ];

  function labelFor(key: ServiceKey): string {
    switch (key) {
      case "llama":
        return "Language Model";
      case "whisper":
        return "Speech-to-Text";
      case "tts":
        return ttsState.enabled ? "Text-to-Speech" : "Text-to-Speech (off)";
      case "tool":
        return "Tools";
    }
  }

  function endpointFor(key: ServiceKey): string | null {
    const s = settingsState.currentSettings;
    if (key === "llama") {
      return `${s["llm.host"] || "127.0.0.1"}:${s["llm.port"] || "7701"}`;
    }
    if (key === "whisper") {
      return `${s["stt.host"] || "127.0.0.1"}:${s["stt.port"] || "7702"}`;
    }
    return null;
  }

  function statusFor(key: ServiceKey): string {
    return serversState.serverStatuses[key]?.status ?? "Disabled";
  }
</script>

<FieldCard {field}>
  <div class="flex flex-col gap-2 pb-1">
    {#each SERVICES as sc}
      {@const status = statusFor(sc.key)}
      {@const endpoint = endpointFor(sc.key)}
      {#if status !== "Disabled"}
        <div class="flex items-baseline gap-3 rounded-large">
          <div class="flex flex-col flex-1 min-w-0">
            <div class="text-default-800 text-sm truncate">
              {labelFor(sc.key)}
            </div>
            <div class="text-default-500 text-xs truncate">
              {status}{endpoint ? ` · ${endpoint}` : ""}
            </div>
          </div>
        </div>
      {/if}
    {/each}
  </div>
</FieldCard>
