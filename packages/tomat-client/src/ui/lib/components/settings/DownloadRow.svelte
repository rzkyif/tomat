<script lang="ts">
  import type { DownloadItem } from "$lib/shared/types";
  import { SETTINGS_SCHEMA } from "@tomat/shared";
  import { downloadsState } from "../../state";
  import { formatBytes } from "$lib/shared/format";
  import IconButton from "../ui/IconButton.svelte";

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
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Cancel download"
          size="sm"
          variant="subtle"
          class="hover:bg-surface-inset"
          onclick={() => downloadsState.cancel(item.id)}
        />
      </div>
    {:else if item.status === "Pending"}
      <div class={xWrapClass}>
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Remove from queue"
          size="sm"
          variant="subtle"
          class="hover:bg-surface-inset"
          onclick={() => downloadsState.cancel(item.id)}
        />
      </div>
    {:else if item.status === "Completed"}
      <IconButton
        icon="i-material-symbols-folder-open-rounded"
        title="Reveal in file manager"
        size="sm"
        variant="subtle"
        class="hover:bg-surface-inset"
        onclick={() => downloadsState.reveal(item.abs_path)}
      />
      <div class={xWrapClass}>
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Remove from list"
          size="sm"
          variant="subtle"
          class="hover:bg-surface-inset"
          onclick={() => downloadsState.remove(item.id)}
        />
      </div>
    {:else if item.status === "Error"}
      <IconButton
        icon="i-material-symbols-refresh-rounded"
        title="Retry download"
        size="sm"
        class="text-accent-red-400 hover:text-accent-red-600 hover:bg-accent-red-100"
        onclick={() => downloadsState.retry(item.id)}
      />
      <div class={xWrapClass}>
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Remove from list"
          size="sm"
          variant="subtle"
          class="hover:bg-surface-inset"
          onclick={() => downloadsState.remove(item.id)}
        />
      </div>
    {:else if item.status === "Cancelled"}
      <IconButton
        icon="i-material-symbols-refresh-rounded"
        title="Retry download"
        size="sm"
        variant="subtle"
        class="hover:bg-surface-inset"
        onclick={() => downloadsState.retry(item.id)}
      />
      <div class={xWrapClass}>
        <IconButton
          icon="i-material-symbols-close-rounded"
          title="Remove from list"
          size="sm"
          variant="subtle"
          class="hover:bg-surface-inset"
          onclick={() => downloadsState.remove(item.id)}
        />
      </div>
    {/if}
  </div>
</div>
