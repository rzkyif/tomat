<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { BUN_SIDECAR_HOST, BUN_SIDECAR_PORT } from "$lib/shared/network";
  import type { SettingField } from "$lib/shared/settings";
  import { serversState, settingsState } from "../../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import FieldCard from "./FieldCard.svelte";

  let { field, horizontal = false } = $props<{
    field: SettingField;
    horizontal?: boolean;
  }>();

  let rootEl: HTMLDivElement | undefined = $state();

  type ProcessMetrics = {
    pid: number;
    rss_mb: number;
    cpu_pct: number;
    running: boolean;
  };

  let metrics = $state<Record<string, ProcessMetrics>>({});

  type ServiceKey = "main" | "llm" | "stt" | "bun";
  const SERVICES: Array<{ key: ServiceKey }> = [
    { key: "main" },
    { key: "llm" },
    { key: "stt" },
    { key: "bun" },
  ];

  function labelFor(key: ServiceKey): string {
    switch (key) {
      case "main":
        return "Main Application";
      case "llm":
        return "Language Model";
      case "stt":
        return "Speech-to-Text";
      case "bun":
        return ttsState.enabled ? "Text-to-Speech + Tools" : "Tools";
    }
  }

  function endpointFor(key: ServiceKey): string | null {
    if (key === "main") return null;
    const s = settingsState.currentSettings;
    if (key === "bun") return `${BUN_SIDECAR_HOST}:${BUN_SIDECAR_PORT}`;
    const host = s[`${key}.host`] || "127.0.0.1";
    const port = s[`${key}.port`] || (key === "llm" ? "7701" : "7702");
    return `${host}:${port}`;
  }

  function statusFor(key: ServiceKey): string {
    if (key === "main") return metrics.main?.running ? "Running" : "Loading";
    return serversState.serverStatuses[key]?.status ?? "Disabled";
  }

  async function refresh() {
    try {
      metrics = (await invoke("get_process_metrics")) as Record<
        string,
        ProcessMetrics
      >;
    } catch (e) {
      console.warn("get_process_metrics failed", e);
    }
  }

  // Only poll when the field is on-screen. Settings is a tall scrolling
  // surface and we don't need live metrics while the user is on another tab.
  $effect(() => {
    if (!rootEl) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId !== null) return;
      refresh();
      intervalId = setInterval(refresh, 2000);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(rootEl);
    return () => {
      io.disconnect();
      stop();
    };
  });

  function formatRam(mb: number): string {
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  const totals = $derived.by(() => {
    let ram = 0;
    let cpu = 0;
    let any = false;
    for (const m of Object.values(metrics)) {
      if (!m?.running) continue;
      ram += m.rss_mb;
      cpu += m.cpu_pct;
      any = true;
    }
    return { ram, cpu, any };
  });
</script>

<FieldCard {field}>
  <div bind:this={rootEl} class="flex flex-col gap-2 pb-1">
    {#each SERVICES as sc}
      {@const status = statusFor(sc.key)}
      {@const endpoint = endpointFor(sc.key)}
      {@const m = metrics[sc.key]}
      {#if sc.key === "bun" || status !== "Disabled"}
        <div class="flex items-baseline gap-3 rounded-xl">
          <div class="flex flex-col flex-1 min-w-0">
            <div class="text-default-800 text-sm truncate">
              {labelFor(sc.key)}
            </div>
            <div class="text-default-500 text-xs truncate">
              {status}{endpoint ? ` · ${endpoint}` : ""}
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <div
              class="text-default-500 text-xs tabular-nums text-right {horizontal
                ? 'w-20'
                : 'w-12'}"
            >
              {m && m.running
                ? `${m.cpu_pct.toFixed(1)}%${horizontal ? " CPU" : ""}`
                : ""}
            </div>
            <div
              class="text-default-500 text-xs tabular-nums text-right {horizontal
                ? 'w-20'
                : 'w-16'}"
            >
              {m && m.running ? formatRam(m.rss_mb) : "-"}
            </div>
          </div>
        </div>
      {/if}
    {/each}
    <div class="flex items-center gap-3 rounded-xl">
      <div class="text-default-800 text-sm flex-1 min-w-0 truncate">Total</div>
      <div class="flex items-center gap-2 shrink-0">
        <div
          class="text-default-500 text-xs font-bold tabular-nums text-right {horizontal
            ? 'w-20'
            : 'w-12'}"
        >
          {totals.any
            ? `${totals.cpu.toFixed(1)}%${horizontal ? " CPU" : ""}`
            : ""}
        </div>
        <div
          class="text-default-500 text-xs font-bold tabular-nums text-right {horizontal
            ? 'w-20'
            : 'w-16'}"
        >
          {totals.any ? formatRam(totals.ram) : "-"}
        </div>
      </div>
    </div>
  </div>
</FieldCard>
