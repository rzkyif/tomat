<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import { onMount } from "svelte";
  import { serversState, settingsState } from "../../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import { platform } from "$lib/platform";
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

  // Channel-aware default sidecar ports (beta → 7711/7712), resolved from the
  // platform on mount. Until then, show the stable defaults.
  let defaultLlmPort = $state("7701");
  let defaultSttPort = $state("7702");
  onMount(() => {
    void platform().pairing.localSidecarPorts().then((p) => {
      defaultLlmPort = String(p.llm);
      defaultSttPort = String(p.stt);
    }).catch(() => {});
  });

  function endpointFor(key: ServiceKey): string | null {
    const s = settingsState.currentSettings;
    if (key === "llama") {
      return `${s["llm.host"] || "127.0.0.1"}:${s["llm.port"] || defaultLlmPort}`;
    }
    if (key === "whisper") {
      return `${s["stt.host"] || "127.0.0.1"}:${s["stt.port"] || defaultSttPort}`;
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
