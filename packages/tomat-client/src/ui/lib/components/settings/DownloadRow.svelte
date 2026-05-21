<script lang="ts">
  import type { DownloadItem } from "$lib/shared/types";
  import { SETTINGS_SCHEMA } from "@tomat/shared";
  import { downloadsState } from "../../state";
  import { formatBytes } from "$lib/shared/format";

  let { item } = $props<{ item: DownloadItem }>();

  // The row icon is borrowed from the settings group that initiated the
  // download (e.g. the LLM brain icon for an llm.modelPath fetch). Falls
  // back to a generic download icon when the group_id is unknown.
  const groupIcon = $derived(
    SETTINGS_SCHEMA.find((g) => g.id === item.group_id)?.icon ??
      "i-material-symbols-download-rounded",
  );

  const isFlashing = $derived(downloadsState.flashingIds.has(item.id));

  const progressPct = $derived(() => {
    if (item.size_bytes && item.size_bytes > 0) {
      return Math.min(100, (item.downloaded_bytes / item.size_bytes) * 100);
    }
    return 0;
  });

  // Row bg per status. The active progress-bar bg is applied as an absolute
  // positioned fill div below so the row content (text + actions) sits on
  // top with no inversion (matches the user's "no text/bg inversion" ask).
  const rowBg = $derived(() => {
    if (isFlashing) return "bg-accent-green-200";
    if (item.status === "Downloading" || item.status === "Pending")
      return "bg-default-200/40";
    return "";
  });

  const textClass = $derived(() => {
    if (item.status === "Error") return "text-accent-red-400";
    if (item.status === "Pending" || item.status === "Cancelled")
      return "text-default-500";
    return "text-default-800";
  });

  const sizeText = $derived(() => {
    if (item.size_bytes != null && item.status === "Downloading") {
      return `${formatBytes(item.downloaded_bytes)} / ${formatBytes(item.size_bytes)}`;
    }
    if (item.size_bytes != null) return formatBytes(item.size_bytes);
    return "";
  });

  // The X (remove / cancel) button is rendered inside a width-animating
  // wrapper that collapses to 0 by default and grows to the button's
  // natural width on row hover. The wrapper handles overflow-clip so the
  // button itself keeps its natural sizing - putting the clip on the
  // button caused the icon mask to render scaled-down rather than clipped.
  const xWrapClass =
    "overflow-clip w-0 group-hover:w-5 transition-[width] duration-150 shrink-0";
  const xBtnClass =
    "flex p-0.5 rounded hover:bg-default-300 text-default-600 hover:text-default-800 hover:cursor-pointer transition-colors";
</script>

<div
  class="group relative flex items-center gap-2 h-8 px-2 rounded-small overflow-hidden transition-colors duration-1000 {rowBg()}"
  title={item.error ?? `${item.filename} (${item.rel_path})`}
>
  {#if item.status === "Downloading"}
    <!-- progress fill behind the row content -->
    <div
      class="absolute inset-y-0 left-0 bg-default-300/60 transition-[width] duration-200"
      style="width: {progressPct()}%"
    ></div>
  {/if}

  <i class="flex text-base shrink-0 relative z-10 {textClass()} {groupIcon}"
  ></i>

  <div class="flex-1 min-w-0 relative z-10 flex items-center gap-2">
    <span class="text-sm truncate {textClass()}">{item.filename}</span>
    {#if sizeText()}
      <span class="text-xs text-default-500 tabular-nums shrink-0">
        {sizeText()}
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-1 shrink-0 relative z-10">
    {#if item.status === "Downloading"}
      <span class="text-xs tabular-nums text-default-700">
        {Math.round(progressPct())}%
      </span>
      <div class={xWrapClass}>
        <button
          class={xBtnClass}
          title="Cancel download"
          onclick={() => downloadsState.cancel(item.id)}
        >
          <i class="flex i-material-symbols-close-rounded text-base"></i>
        </button>
      </div>
    {:else if item.status === "Pending"}
      <div class={xWrapClass}>
        <button
          class={xBtnClass}
          title="Remove from queue"
          onclick={() => downloadsState.cancel(item.id)}
        >
          <i class="flex i-material-symbols-close-rounded text-base"></i>
        </button>
      </div>
    {:else if item.status === "Completed"}
      <button
        class="flex p-0.5 rounded hover:bg-default-300 text-default-600 hover:text-default-800 hover:cursor-pointer transition-colors"
        title="Reveal in file manager"
        onclick={() => downloadsState.reveal(item.abs_path)}
      >
        <i class="flex i-material-symbols-folder-open-rounded text-base"></i>
      </button>
      <div class={xWrapClass}>
        <button
          class={xBtnClass}
          title="Remove from list"
          onclick={() => downloadsState.remove(item.id)}
        >
          <i class="flex i-material-symbols-close-rounded text-base"></i>
        </button>
      </div>
    {:else if item.status === "Error"}
      <button
        class="flex p-0.5 rounded hover:bg-accent-red-100 text-accent-red-400 hover:text-accent-red-600 hover:cursor-pointer transition-colors"
        title="Retry download"
        onclick={() => downloadsState.retry(item.id)}
      >
        <i class="flex i-material-symbols-refresh-rounded text-base"></i>
      </button>
      <div class={xWrapClass}>
        <button
          class={xBtnClass}
          title="Remove from list"
          onclick={() => downloadsState.remove(item.id)}
        >
          <i class="flex i-material-symbols-close-rounded text-base"></i>
        </button>
      </div>
    {:else if item.status === "Cancelled"}
      <button
        class="flex p-0.5 rounded hover:bg-default-300 text-default-600 hover:text-default-800 hover:cursor-pointer transition-colors"
        title="Retry download"
        onclick={() => downloadsState.retry(item.id)}
      >
        <i class="flex i-material-symbols-refresh-rounded text-base"></i>
      </button>
      <div class={xWrapClass}>
        <button
          class={xBtnClass}
          title="Remove from list"
          onclick={() => downloadsState.remove(item.id)}
        >
          <i class="flex i-material-symbols-close-rounded text-base"></i>
        </button>
      </div>
    {/if}
  </div>
</div>
