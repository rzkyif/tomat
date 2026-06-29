<script lang="ts" module>
  // The single status a CoreBar paints: the backend CoreStatus merged with the
  // client's transport states (which never ride the wire). The client wrapper
  // computes the merge; the website feeds a static value.
  // A non-connected transport never distinguishes "disconnected" from
  // "connecting" (the client collapses both into connecting, then reconnecting
  // after a grace period), so there is no "disconnected" member here.
  export type DisplayCoreStatus =
    | "starting_up"
    | "idle"
    | "busy"
    | "updating"
    | "error"
    | "connecting"
    | "reconnecting"
    | "unauthorized";

  type StatusMeta = { icon: string; tone: string; label: string; spin: boolean };

  const STATUS_META: Record<DisplayCoreStatus, StatusMeta> = {
    starting_up: {
      icon: "i-material-symbols-progress-activity",
      tone: "text-default-700",
      label: "Starting up",
      spin: true,
    },
    idle: {
      icon: "i-material-symbols-check-circle-rounded",
      tone: "text-accent-green-700",
      label: "Ready",
      spin: false,
    },
    busy: {
      icon: "i-material-symbols-progress-activity",
      tone: "text-accent-yellow-700",
      label: "Busy",
      spin: true,
    },
    updating: {
      icon: "i-material-symbols-progress-activity",
      tone: "text-accent-blue-700",
      label: "Updating",
      spin: true,
    },
    error: {
      icon: "i-material-symbols-error-rounded",
      tone: "text-accent-red-700",
      label: "Error",
      spin: false,
    },
    connecting: {
      icon: "i-material-symbols-progress-activity",
      tone: "text-default-700",
      label: "Connecting",
      spin: true,
    },
    reconnecting: {
      icon: "i-material-symbols-progress-activity",
      tone: "text-accent-yellow-700",
      label: "Reconnecting",
      spin: true,
    },
    unauthorized: {
      icon: "i-material-symbols-lock",
      tone: "text-accent-red-700",
      label: "Re-pair needed",
      spin: false,
    },
  };
</script>

<script lang="ts">
  import Bubble from "../primitives/Bubble.svelte";
  import ButtonGroup from "../primitives/ButtonGroup.svelte";
  import Expand from "../primitives/Expand.svelte";
  import ErrorDetailView from "./messages/ErrorDetailView.svelte";
  import FlushSelect from "../primitives/FlushSelect.svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import { useUiContext } from "../../context.ts";
  import { RIPPLE_MS } from "../../animations.ts";
  import { ripple } from "../../actions/ripple.ts";
  import type { SidecarKind } from "../../../domain/model.ts";
  import type { CoreQueues, SubsystemStatus } from "../../../domain/core-status.ts";

  // The core bar: a small bubble showing which core the client is connected to,
  // its merged status, and a quick switcher. When the status carries extra
  // detail (a failure, queued work, or something loading) the status pill
  // becomes a toggle that expands a card listing the specifics, folding every
  // sidecar failure into the one core status. All data + the switch / manage /
  // expand actions are owned by the client wrapper and supplied via props; the
  // website feeds static values. Alignment comes from the UI context so both
  // apps match.
  const ui = useUiContext();
  // On mobile the core bar is the chat screen's top app bar: it spans the full
  // width, its status + switcher stay centered, and the Settings entry point
  // lives at the right edge (it is dropped from the composer there).
  const mobile = ui.platform === "mobile";
  const rippleDuration = $derived(ui.animationDurationMs(RIPPLE_MS));

  // User-facing names for the subsystems, per COPY.md (no mechanism words). STT
  // and TTS share the one speech process, so it is a single "Speech" subsystem.
  const SUBSYSTEM_NAMES: Record<SidecarKind, string> = {
    llama: "Language Model",
    "llama-embed": "Search",
    speech: "Speech",
    tool: "Tools",
  };

  let {
    status,
    detail = undefined,
    progress = undefined,
    subsystems = [],
    queues = undefined,
    cores = [],
    currentCoreId = "",
    expanded = false,
    onToggleExpand = undefined,
    onSwitch,
    onManageCores = undefined,
    onSettings = undefined,
    baseColorOverride = null,
  }: {
    status: DisplayCoreStatus;
    /** Short detail for the tooltip (e.g. "loading whisper", "3 queued"). */
    detail?: string;
    /** 0..1 boot/load progress; appended to the label when starting up. */
    progress?: number;
    /** Per-subsystem breakdown; drives the expanded error / loading list. */
    subsystems?: SubsystemStatus[];
    /** Queue / in-flight counts; drives the expanded busy list. */
    queues?: CoreQueues;
    cores?: { id: string; name: string }[];
    currentCoreId?: string;
    /** Whether the detail card is open (controlled by the wrapper's registry). */
    expanded?: boolean;
    /** Toggle the detail card; only wired when there is detail to show. */
    onToggleExpand?: () => void;
    onSwitch?: (id: string) => void;
    onManageCores?: () => void;
    /** Mobile only: opens Settings from the top app bar (the gear is dropped
     *  from the composer there). Omitted on desktop. */
    onSettings?: () => void;
    baseColorOverride?: string | null;
  } = $props();

  const meta = $derived(STATUS_META[status]);
  const pct = $derived(
    status === "starting_up" && typeof progress === "number"
      ? ` ${Math.round(progress * 100)}%`
      : "",
  );
  const options = $derived(cores.map((c) => ({ value: c.id, label: c.name })));

  const erroredSubsystems = $derived(subsystems.filter((s) => s.status === "Error"));
  const loadingSubsystems = $derived(subsystems.filter((s) => s.status === "Loading"));
  // The lines shown while busy: each queue that has work, plus the active turns.
  const busyLines = $derived.by<string[]>(() => {
    if (!queues) return [];
    const lines: string[] = [];
    if (queues.llmActive > 0 || queues.llmQueued > 0) {
      lines.push(`Language Model: ${queues.llmActive} working, ${queues.llmQueued} waiting`);
    }
    if (queues.speechActive > 0 || queues.speechQueued > 0) {
      lines.push(`Speech: ${queues.speechActive} working, ${queues.speechQueued} waiting`);
    }
    if (queues.activeStreams > 0) lines.push(`Active sessions: ${queues.activeStreams}`);
    return lines;
  });

  // Only the states that actually carry specifics are expandable: a failure, a
  // busy queue, or something loading. Everything else paints a plain pill.
  const hasDetail = $derived(
    (status === "error" && erroredSubsystems.length > 0) ||
      (status === "busy" && busyLines.length > 0) ||
      (status === "starting_up" && loadingSubsystems.length > 0),
  );
  const open = $derived(expanded && hasDetail);

  function subsystemName(kind: SidecarKind): string {
    return SUBSYSTEM_NAMES[kind] ?? kind;
  }
</script>

{#snippet pillInner()}
  <i class="flex text-base {meta.icon} {meta.spin ? 'animate-spin' : ''}"></i>
  <span class="text-sm whitespace-nowrap">{meta.label}{pct}</span>
  {#if hasDetail}
    <i
      class="flex text-base i-material-symbols-chevron-right-rounded transition-transform duration-200 {open
        ? 'rotate-90'
        : ''}"
    ></i>
  {/if}
{/snippet}

<div style:display="contents" style:--default-base={baseColorOverride}>
  <Bubble
    selectedAlignment={ui.getAlignment()}
    fullWidth={mobile}
    size="small"
    extraClass="flex flex-col gap-2"
  >
    {#if mobile}
      <!-- Mobile top app bar: status + switcher packed to the left, the Settings
           gear pinned to the right edge (ml-auto). -->
      <div class="flex items-center gap-2 w-full">
        {@render headerRegions()}
        {#if onSettings}
          <IconButton
            icon="i-material-symbols-settings-outline-rounded"
            title="Settings"
            size="lg"
            variant="subtle"
            surface="circle"
            class="ml-auto shrink-0"
            onclick={() => onSettings?.()}
          />
        {/if}
      </div>
    {:else}
      <!-- Header row. Collapsed it packs left; expanded the status pill stays left
           and the switcher + manage button move to the right edge (justify-between
           over the card's width below). -->
      <div class="flex items-center gap-2" class:w-full={open} class:justify-between={open}>
        {@render headerRegions()}
      </div>
    {/if}

    <!-- Detail card: matches the system-prompt / thinking bubble inset card. -->
    {#if hasDetail}
      <Expand {open}>
        <div
          class="bg-surface-inset px-4 py-2 rounded-large text-default-700 text-xs text-left flex flex-col gap-2"
        >
          {#if status === "error"}
            {#each erroredSubsystems as s (s.kind)}
              <ErrorDetailView message={subsystemName(s.kind)} detail={s.message} />
            {/each}
          {:else if status === "busy"}
            {#each busyLines as line (line)}
              <div>{line}</div>
            {/each}
          {:else if status === "starting_up"}
            {#each loadingSubsystems as s (s.kind)}
              <div>{subsystemName(s.kind)} is loading</div>
            {/each}
          {/if}
        </div>
      </Expand>
    {/if}
  </Bubble>
</div>

<!-- The status pill + core switcher, shared by the desktop row and the mobile
     centered app-bar layout. Defined at the top level (not inside <Bubble>) so it
     is a local snippet, not a snippet prop passed to Bubble. -->
{#snippet headerRegions()}
  <!-- Connected-core status. An inset pill (like the SessionBar gauge) so the
       bar's regions read as solid controls rather than floating text. The tone
       colors the icon and label by status, at the SessionBar text lightness (the
       -700 shade). When there is detail it becomes a toggle. -->
  {#if hasDetail}
    <button
      type="button"
      data-region="core-status"
      title={detail ?? meta.label}
      aria-expanded={open}
      onclick={() => onToggleExpand?.()}
      class="flex items-center gap-1.5 shrink-0 h-8 px-3 bg-surface-inset rounded-large transition-interactive hov:bg-surface-inset-strong hov:cursor-pointer {meta.tone}"
      use:ripple={{ durationMs: rippleDuration }}
    >
      {@render pillInner()}
    </button>
  {:else}
    <span
      data-region="core-status"
      class="flex items-center gap-1.5 shrink-0 h-8 px-3 bg-surface-inset rounded-large {meta.tone}"
      title={detail ?? meta.label}
    >
      {@render pillInner()}
    </span>
  {/if}

  <div class="flex items-center gap-2 min-w-0">
    <!-- Quick core switcher, housed in an inset pill matching the SessionBar
         title field. The FlushSelect carries the pill styling itself so its
         transparent <select> overlay covers the whole pill, at the SessionBar
         text lightness rather than the dim flush tone. -->
    <FlushSelect
      value={currentCoreId}
      {options}
      onchange={(v) => onSwitch?.(v)}
      ariaLabel="Connected core"
      title="Switch core"
      rounded="rounded-large"
      textClass="text-default-700 hov:text-default-900"
      class="h-8 px-3 bg-surface-inset"
    />

    <ButtonGroup size="sm" class="shrink-0">
      <IconButton
        icon="i-material-symbols-hub-outline"
        title="Manage cores"
        size="sm"
        onclick={() => onManageCores?.()}
      />
    </ButtonGroup>
  </div>
{/snippet}
