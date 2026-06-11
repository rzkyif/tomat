<script lang="ts">
  import type { SettingField, SidecarsStatusResponse } from "@tomat/shared";
  import { onMount } from "svelte";
  import { cores } from "$lib/core";
  import { serversState, settingsState } from "../../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import { platform } from "$lib/platform";
  import { formatBytes } from "$lib/shared/format";
  import { getLogger } from "$lib/shared/log";
  import FieldCard from "./FieldCard.svelte";

  const log = getLogger("services");

  let {
    field,
    scope,
    horizontal = false,
  } = $props<{
    field: SettingField;
    scope: "client" | "core";
    horizontal?: boolean;
  }>();

  type ServiceKey = "llama" | "whisper" | "tts" | "tool";
  const SERVICES: ServiceKey[] = ["llama", "whisper", "tts", "tool"];

  // Core-scope metrics (core process + sidecars); client-scope metrics (the
  // desktop app process). Each polled only while the field is on-screen.
  let metrics = $state<SidecarsStatusResponse | null>(null);
  let mainMetrics = $state<{ rssMb: number; cpuPct: number } | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);

  // Wider metric columns when the settings panel is laid out horizontally.
  const cpuW = $derived(horizontal ? "w-16" : "w-12");
  const ramW = $derived(horizontal ? "w-20" : "w-16");

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
    if (scope !== "core") return;
    void platform()
      .pairing.localSidecarPorts()
      .then((p) => {
        defaultLlmPort = String(p.llm);
        defaultSttPort = String(p.stt);
      })
      .catch((e) => log.debug("localSidecarPorts failed", e));
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
    // tts isn't supervised by the sidecar manager, so no sidecar.status WS
    // frames ever reach serversState for it. The polled metrics snapshot
    // (which the status route synthesizes while the tts worker is up) is
    // the authority instead.
    if (key === "tts") return sidecarMetric(key)?.status ?? "Disabled";
    return serversState.serverStatuses[key]?.status ?? "Disabled";
  }

  function sidecarMetric(
    key: ServiceKey,
  ): { status?: string; rssMb?: number; cpuPct?: number } | undefined {
    return metrics?.sidecars.find((s) => s.kind === key);
  }

  type Row = { label: string; sub?: string; rssMb?: number; cpuPct?: number };

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    if (scope === "client") {
      if (mainMetrics) {
        out.push({
          label: "Main Application",
          rssMb: mainMetrics.rssMb,
          cpuPct: mainMetrics.cpuPct,
        });
      }
      return out;
    }
    // core scope: the core process + its sidecars.
    if (metrics?.core) {
      out.push({
        label: "Core Service",
        rssMb: metrics.core.rssMb,
        cpuPct: metrics.core.cpuPct,
      });
    }
    for (const key of SERVICES) {
      const m = sidecarMetric(key);
      // tts is only running while loaded; tool is an ephemeral per-call worker
      // with no persistent process to measure.
      if (key === "tool") continue;
      const status = statusFor(key);
      if (key === "tts" ? !m : status === "Disabled") continue;
      const endpoint = endpointFor(key);
      out.push({
        label: labelFor(key),
        sub: `${status}${endpoint ? ` · ${endpoint}` : ""}`,
        rssMb: m?.rssMb,
        cpuPct: m?.cpuPct,
      });
    }
    return out;
  });

  const totalRss = $derived(rows.reduce((s, r) => s + (r.rssMb ?? 0), 0));
  const totalCpu = $derived(rows.reduce((s, r) => s + (r.cpuPct ?? 0), 0));

  function fmtCpu(pct: number | undefined): string {
    return pct === undefined ? "-" : `${pct.toFixed(1)}%`;
  }
  function fmtRam(mb: number | undefined): string {
    return mb === undefined ? "-" : formatBytes(mb * 1024 * 1024);
  }

  async function refresh() {
    if (scope === "client") {
      try {
        const self = await platform().process.selfMetrics();
        // pid 0 (web stub) means the platform can't measure itself; drop the row.
        mainMetrics =
          self.pid !== 0 ? { rssMb: self.rssMb, cpuPct: self.cpuPct } : null;
      } catch (e) {
        log.debug("selfMetrics failed", e);
      }
      return;
    }
    // No paired/selected core yet: nothing to poll (cores().api() would throw).
    if (!cores().currentClient()) return;
    try {
      metrics = await cores().api().sidecars.status();
    } catch (e) {
      log.debug("metrics refresh failed", e);
    }
  }

  // Poll every 2s, but only while the field is actually visible (the settings
  // panel is tall; no point sampling sysinfo when scrolled away).
  $effect(() => {
    if (!rootEl) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId !== null) return;
      void refresh();
      intervalId = setInterval(() => void refresh(), 2000);
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
</script>

<FieldCard {field}>
  <!-- Indented (pl-5) to match the Storage field's items, so the table sits
       apart from the field label. -->
  <div class="flex flex-col gap-2 pb-1 pl-5" bind:this={rootEl}>
    <!-- Column header -->
    <div
      class="flex items-baseline gap-3 text-default-400 text-[10px] uppercase tracking-wider select-none"
    >
      <div class="flex-1 min-w-0">Service Name</div>
      <div class="flex items-center gap-2 shrink-0">
        <div class="text-right {cpuW}">CPU</div>
        <div class="text-right {ramW}">RAM</div>
      </div>
    </div>

    {#each rows as row}
      <div class="flex items-baseline gap-3">
        <div class="flex flex-col flex-1 min-w-0">
          <div class="text-default-800 text-sm truncate">{row.label}</div>
          {#if row.sub}
            <div class="text-default-500 text-xs truncate">{row.sub}</div>
          {/if}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="text-default-500 text-xs tabular-nums text-right {cpuW}">
            {fmtCpu(row.cpuPct)}
          </div>
          <div class="text-default-500 text-xs tabular-nums text-right {ramW}">
            {fmtRam(row.rssMb)}
          </div>
        </div>
      </div>
    {/each}

    <div class="flex items-baseline gap-3">
      <div class="text-default-800 text-sm flex-1 min-w-0 truncate">Total</div>
      <div class="flex items-center gap-2 shrink-0">
        <div
          class="text-default-500 text-xs font-bold tabular-nums text-right {cpuW}"
        >
          {rows.length > 0 ? `${totalCpu.toFixed(1)}%` : "-"}
        </div>
        <div
          class="text-default-500 text-xs font-bold tabular-nums text-right {ramW}"
        >
          {rows.length > 0 ? formatBytes(totalRss * 1024 * 1024) : "-"}
        </div>
      </div>
    </div>
  </div>
</FieldCard>
