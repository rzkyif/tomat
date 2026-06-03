<script lang="ts">
  // Storage browser for downloaded models. The core owns ~/.tomat/models and
  // serves the tree + handles deletes; this renders it and lets the user
  // reclaim disk. Sessions live in SQLite (managed from the session bar) and
  // snippets are client-local (managed in the Snippets settings field), so
  // neither is part of this core disk view - only models are shown.
  import { onMount } from "svelte";
  import type { SettingField } from "@tomat/shared";
  import { cores } from "$lib/core";
  import { confirmState, settingsState } from "../../../state";
  import { formatBytes } from "$lib/shared/format";
  import {
    collectModelFiles,
    collectPaths,
    computeLockReasons,
    expandToFiles,
    findNode,
    visibleRows,
    type StorageNode,
    type StorageTree,
  } from "$lib/shared/storage-tree";
  import FieldCard from "./FieldCard.svelte";

  let { field } = $props<{ field: SettingField }>();

  let tree = $state<StorageTree | null>(null);
  let loading = $state(true);
  // Models are always shown (the "__models__" group stays expanded); individual
  // multi-file repos collapse/expand on their own path key.
  let expanded = $state<Set<string>>(new Set(["__models__"]));
  let selected = $state<Set<string>>(new Set());
  let lastSelectedPath = $state<string | null>(null);

  // Path -> reason for every file (and fully-locked folder) currently in use by
  // a configured model, so those rows can't be selected/deleted.
  const lockReasons = $derived(
    tree ? computeLockReasons(tree, settingsState.currentSettings) : new Map<string, string>(),
  );

  async function refresh() {
    loading = true;
    try {
      tree = await cores().api().storage.get();
      // Drop selections for paths that no longer exist.
      const all = new Set<string>();
      if (tree) for (const n of tree.models) collectPaths(n, all);
      const next = new Set<string>();
      for (const p of selected) if (all.has(p)) next.add(p);
      selected = next;
    } catch (e) {
      console.warn("[storage] load failed:", e);
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function toggleExpand(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function handleRowClick(e: MouseEvent, node: StorageNode) {
    if (lockReasons.has(node.path)) {
      // Locked rows aren't selectable, but locked folders still expand.
      if (node.kind === "folder" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        toggleExpand(node.path);
      }
      return;
    }
    const path = node.path;
    const next = new Set(selected);
    if (e.shiftKey && lastSelectedPath && tree) {
      const rows = visibleRows(tree, expanded)
        .map((r) => r.path)
        .filter((p) => !lockReasons.has(p));
      const a = rows.indexOf(lastSelectedPath);
      const b = rows.indexOf(path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(rows[i]);
      } else {
        next.add(path);
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(path)) next.delete(path);
      else next.add(path);
    } else {
      next.clear();
      next.add(path);
      if (node.kind === "folder") toggleExpand(path);
    }
    selected = next;
    lastSelectedPath = path;
  }

  function hasClearableModels(): boolean {
    if (!tree) return false;
    return collectModelFiles(tree).some((p) => !lockReasons.has(p));
  }

  async function deletePaths(paths: string[]) {
    try {
      await cores().api().storage.deletePaths(paths);
    } catch (err) {
      console.error("[storage] delete failed:", err);
    }
    await refresh();
  }

  function deleteSelected() {
    if (selected.size === 0 || !tree) return;
    const all = expandToFiles(tree, [...selected]);
    const toDelete = all.filter((p) => !lockReasons.has(p));
    const skipped = all.length - toDelete.length;
    if (toDelete.length === 0) {
      confirmState.request({
        title: "Delete models",
        message: "Nothing to delete - the selection only contains files currently in use.",
        confirmLabel: "OK",
        onConfirm: () => {},
      });
      return;
    }
    const totalSize = toDelete.reduce((s, p) => s + (findNode(tree!, p)?.size ?? 0), 0);
    const suffix = skipped > 0
      ? ` ${skipped} file${skipped === 1 ? "" : "s"} currently in use will be kept.`
      : "";
    confirmState.request({
      title: "Delete models",
      message:
        `Delete ${toDelete.length} file${toDelete.length === 1 ? "" : "s"} ` +
        `(${formatBytes(totalSize)}) from disk?${suffix} This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
      onConfirm: () => deletePaths(toDelete),
    });
  }

  function requestClearUnused() {
    if (!tree) return;
    const toDelete = collectModelFiles(tree).filter((p) => !lockReasons.has(p));
    if (toDelete.length === 0) {
      confirmState.request({
        title: "Clear unused models",
        message: "No unused models - every downloaded file is currently in use.",
        confirmLabel: "OK",
        onConfirm: () => {},
      });
      return;
    }
    confirmState.request({
      title: "Clear unused models",
      message:
        `Delete ${toDelete.length} unused model file${toDelete.length === 1 ? "" : "s"} ` +
        `from disk? This cannot be undone.`,
      destructive: true,
      confirmLabel: "Clear",
      onConfirm: () => deletePaths(toDelete),
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    const isDelete = e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey));
    if (isDelete && selected.size > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }
</script>

<FieldCard {field}>
  <div
    class="flex flex-col gap-1 outline-none"
    tabindex="0"
    role="tree"
    onkeydown={handleKeyDown}
  >
    {#if loading && !tree}
      <div class="text-default-500 text-sm">Loading…</div>
    {:else if tree && tree.models.length === 0}
      <div class="text-default-400 text-xs py-1 select-none">No models downloaded.</div>
    {:else if tree}
      {#each tree.models as node (node.path)}
        {@const lockReason = lockReasons.get(node.path) ?? null}
        {@const isLocked = lockReason !== null}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center gap-1 text-sm pl-2 py-1 select-none {isLocked
            ? 'opacity-60 ' + (node.kind === 'folder' ? 'cursor-pointer' : 'cursor-default')
            : 'cursor-pointer'} {selected.has(node.path) ? 'bg-default-400' : ''}"
          title={lockReason ?? undefined}
          onclick={(e) => handleRowClick(e, node)}
        >
          {#if node.kind === "folder"}
            <button
              class="flex shrink-0 w-4 justify-center text-default-500 hover:cursor-pointer"
              aria-label="Toggle folder"
              onclick={(e) => {
                e.stopPropagation();
                toggleExpand(node.path);
              }}
            >
              <i
                class="flex {expanded.has(node.path)
                  ? 'i-material-symbols-expand-more-rounded'
                  : 'i-material-symbols-chevron-right-rounded'}"
              ></i>
            </button>
          {:else}
            <span class="flex shrink-0 w-4"></span>
          {/if}
          <i
            class="flex shrink-0 w-4 justify-center {isLocked
              ? 'i-material-symbols-lock-outline'
              : node.kind === 'folder'
                ? 'i-material-symbols-folder-outline-rounded'
                : 'i-material-symbols-description-outline-rounded'} text-default-500"
          ></i>
          <span class="flex-1 truncate text-default-800">{node.name}</span>
          <span class="text-default-500 text-xs tabular-nums shrink-0">{formatBytes(node.size)}</span>
        </div>
        {#if node.kind === "folder" && expanded.has(node.path)}
          {#each node.children as child (child.path)}
            {@const childReason = lockReasons.get(child.path) ?? null}
            {@const childLocked = childReason !== null}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex items-center gap-1 text-sm pl-8 py-1 select-none {childLocked
                ? 'opacity-60 cursor-default'
                : 'cursor-pointer'} {selected.has(child.path) ? 'bg-default-400' : ''}"
              title={childReason ?? undefined}
              onclick={(e) => handleRowClick(e, child)}
            >
              <span class="flex shrink-0 w-4"></span>
              <i
                class="flex shrink-0 w-4 justify-center {childLocked
                  ? 'i-material-symbols-lock-outline'
                  : 'i-material-symbols-description-outline-rounded'} text-default-500"
              ></i>
              <span class="flex-1 truncate text-default-800">{child.name}</span>
              <span class="text-default-500 text-xs tabular-nums shrink-0">
                {formatBytes(child.size)}
              </span>
            </div>
          {/each}
        {/if}
      {/each}

      <!-- Total row -->
      <div class="flex items-center gap-1 text-sm py-1 select-none">
        <span class="flex shrink-0 w-4"></span>
        <span class="text-default-800 font-medium truncate">Total</span>
        <span class="flex-1"></span>
        <span class="text-default-500 text-xs font-bold tabular-nums shrink-0">
          {formatBytes(tree.models_size)}
        </span>
      </div>
    {/if}

    <div class="flex items-center justify-end gap-2 mt-1">
      <button
        type="button"
        class="flex items-center gap-1 bg-surface-inset-strong hover:bg-default-400 text-default-800 rounded-large px-3 h-8 text-sm hover:cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none"
        onclick={requestClearUnused}
        disabled={!hasClearableModels()}
        title="Delete model files that aren't currently in use"
      >
        <i class="flex i-material-symbols-delete-outline-rounded"></i>
        <span>Clear Unused</span>
      </button>
    </div>
  </div>
</FieldCard>
