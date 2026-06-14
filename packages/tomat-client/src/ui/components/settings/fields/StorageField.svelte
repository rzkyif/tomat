<script lang="ts">
  // Full on-disk storage browser. Driven by a provider chosen by `scope`: the
  // paired core (models, binaries, sessions, toolkits, cache, logs, settings)
  // or the local client (settings, logs). The provider serves a tree with a
  // `lock_reason` on anything in use; this renders it, lets the user reclaim
  // disk, and routes every delete through the review modal. The provider
  // re-validates locks, so the client never decides what is safe to remove.
  import { onMount } from "svelte";
  import type { SettingField } from "@tomat/shared";
  import { cores } from "$lib/core";
  import { clientStorageProvider } from "$lib/core/client-storage";
  import { deletionsState, settingsState } from "../../../state";
  import { formatBytes } from "$lib/util/format";
  import {
    categoryKey,
    clearableNodes,
    expandToFiles,
    findNode,
    subtreeLockReason,
    visibleRows,
    type StorageCategory,
    type StorageNode,
    type StorageTree,
  } from "$lib/storage/tree";
  import { getLogger } from "$lib/util/log";
  import FieldCard from "./FieldCard.svelte";

  const log = getLogger("storage");

  let { field, scope } = $props<{ field: SettingField; scope: "client" | "core" }>();

  let tree = $state<StorageTree | null>(null);
  let loading = $state(true);
  let loadError = $state(false);
  let expanded = $state<Set<string>>(new Set());
  let selected = $state<Set<string>>(new Set());
  let lastSelectedPath = $state<string | null>(null);

  // The storage provider for this scope. Both expose get/deletePaths/
  // clearCategory; the core one lives on the selected paired core.
  function provider() {
    return scope === "core" ? cores().api().storage : clientStorageProvider;
  }

  async function refresh() {
    loading = true;
    try {
      // Core scope with no paired/selected core: cores().api() would throw.
      if (scope === "core" && !cores().currentClient()) {
        tree = null;
        loadError = true;
        return;
      }
      tree = await provider().get();
      loadError = false;
      // Drop selections for paths that no longer exist.
      const next = new Set<string>();
      for (const p of selected) if (tree && findNode(tree, p)) next.add(p);
      selected = next;
    } catch (e) {
      log.warn("load failed:", e);
      loadError = true;
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function selectable(node: StorageNode, catId: string): boolean {
    // Settings is reset via its group's Clear button, not row selection.
    return !node.lock_reason && catId !== "settings";
  }

  function handleRowClick(e: MouseEvent, node: StorageNode, catId: string) {
    if (!selectable(node, catId)) {
      // Locked / settings rows aren't selectable, but folders still expand.
      if (node.kind === "folder" && !e.shiftKey && !e.metaKey && !e.ctrlKey) toggle(node.path);
      return;
    }
    const path = node.path;
    const next = new Set(selected);
    if (e.shiftKey && lastSelectedPath && tree) {
      const rows = visibleRows(tree, expanded)
        .filter((r) => selectable(r, catId))
        .map((r) => r.path);
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
      if (node.kind === "folder") toggle(path);
    }
    selected = next;
    lastSelectedPath = path;
  }

  async function deletePaths(paths: string[]) {
    try {
      await provider().deletePaths(paths);
    } catch (err) {
      log.error("delete failed:", err);
    }
    await refresh();
  }

  // Open the review modal for the current multi-selection.
  function deleteSelected() {
    if (selected.size === 0 || !tree) return;
    const paths = expandToFiles(tree, [...selected]);
    const items: { label: string; sizeBytes: number }[] = [];
    const skipped: { label: string; reason: string }[] = [];
    const toDelete: string[] = [];
    for (const p of paths) {
      const n = findNode(tree, p);
      if (!n) continue;
      if (n.lock_reason) skipped.push({ label: n.name, reason: n.lock_reason });
      else {
        items.push({ label: n.name, sizeBytes: n.size });
        toDelete.push(p);
      }
    }
    if (items.length === 0 && skipped.length === 0) return;
    deletionsState.request({
      title: "Delete selected items",
      items,
      skipped,
      onConfirm: () => deletePaths(toDelete),
    });
  }

  // Open the review modal for a whole-category Clear.
  function clearCategory(cat: StorageCategory) {
    if (cat.id === "settings") {
      deletionsState.request({
        title: "Reset settings",
        notice: scope === "core"
          ? "This resets all core settings to their defaults and removes saved API keys and passwords. This cannot be undone."
          : "This resets app settings to their defaults. Paired cores and snippets are kept. This cannot be undone.",
        items: [],
        skipped: [],
        confirmLabel: "Reset",
        onConfirm: () => clearViaApi(cat.id),
      });
      return;
    }
    const items = clearableNodes(cat).map((n) => ({ label: n.name, sizeBytes: n.size }));
    const skipped = cat.nodes
      .map((n) => ({ n, reason: subtreeLockReason(n) }))
      .filter((x) => x.reason)
      .map((x) => ({ label: x.n.name, reason: x.reason! }));
    if (items.length === 0 && skipped.length === 0) return;
    deletionsState.request({
      title: `Clear ${cat.label.toLowerCase()}`,
      items,
      skipped,
      confirmLabel: "Clear",
      onConfirm: () => clearViaApi(cat.id),
    });
  }

  async function clearViaApi(categoryId: string) {
    try {
      await provider().clearCategory(categoryId);
      // A settings reset changes persisted settings; pull them back so the open
      // UI reflects the defaults instead of stale values.
      if (categoryId === "settings") await settingsState.loadSettings();
    } catch (err) {
      log.error("clear failed:", err);
    }
    await refresh();
  }

  function canClear(cat: StorageCategory): boolean {
    if (cat.id === "settings") return cat.nodes.length > 0;
    return clearableNodes(cat).length > 0;
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
  <div class="flex flex-col gap-0.5 outline-none" tabindex="0" role="tree" onkeydown={handleKeyDown}>
    {#if loading && !tree}
      <div class="text-default-500 text-sm py-1 select-none">Loading…</div>
    {:else if loadError && !tree}
      <div class="text-default-400 text-xs py-1 select-none">Couldn't load storage.</div>
    {:else if tree}
      {#each tree.categories as cat (cat.id)}
        {@const open = expanded.has(categoryKey(cat.id))}
        <!-- Category header: the whole row toggles expansion (like a settings
             section header). -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center gap-1 text-sm py-1 select-none cursor-pointer"
          role="button"
          tabindex="-1"
          onclick={() => toggle(categoryKey(cat.id))}
        >
          <i
            class="flex shrink-0 w-4 justify-center text-default-500 {open
              ? 'i-material-symbols-expand-more-rounded'
              : 'i-material-symbols-chevron-right-rounded'}"
          ></i>
          <span class="text-default-800 font-medium truncate">{cat.label}</span>
          {#if canClear(cat)}
            <button
              type="button"
              class="flex shrink-0 w-5 h-5 -ml-0.5 justify-center items-center text-default-500 hover:text-default-900 hover:cursor-pointer transition-colors"
              onclick={(e) => {
                e.stopPropagation();
                clearCategory(cat);
              }}
              aria-label={cat.id === "settings" ? "Reset to defaults" : `Clear ${cat.label}`}
              title={cat.id === "settings" ? "Reset to defaults" : `Clear ${cat.label}`}
            >
              <i
                class="flex {cat.id === 'settings'
                  ? 'i-material-symbols-restart-alt-rounded'
                  : 'i-material-symbols-delete-outline-rounded'}"
              ></i>
            </button>
          {/if}
          <span class="flex-1"></span>
          <span class="text-default-500 text-xs tabular-nums shrink-0">{formatBytes(cat.size)}</span>
        </div>

        {#if open}
          {#if cat.nodes.length === 0}
            <div class="text-default-400 text-xs pl-5 py-1 select-none">Empty.</div>
          {/if}
          {#each cat.nodes as node (node.path)}
            {@const isLocked = !!node.lock_reason}
            {@const isSel = selected.has(node.path)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex items-center gap-1 text-sm pl-5 py-1 select-none {isLocked ||
              cat.id === 'settings'
                ? node.kind === 'folder'
                  ? 'cursor-pointer'
                  : 'cursor-default'
                : 'cursor-pointer'} {isLocked ? 'opacity-60' : ''} {isSel ? 'bg-default-400' : ''}"
              title={node.lock_reason ?? undefined}
              onclick={(e) => handleRowClick(e, node, cat.id)}
            >
              {#if node.kind === "folder" && node.children.length > 0}
                <button
                  class="flex shrink-0 w-4 justify-center text-default-500 hover:cursor-pointer"
                  aria-label="Toggle folder"
                  onclick={(e) => {
                    e.stopPropagation();
                    toggle(node.path);
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
              <span class="text-default-500 text-xs tabular-nums shrink-0">
                {formatBytes(node.size)}
              </span>
            </div>
            {#if node.kind === "folder" && expanded.has(node.path)}
              {#each node.children as child (child.path)}
                {@const childLocked = !!child.lock_reason}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="flex items-center gap-1 text-sm pl-10 py-1 select-none {childLocked
                    ? 'opacity-60 cursor-default'
                    : 'cursor-pointer'} {selected.has(child.path) ? 'bg-default-400' : ''}"
                  title={child.lock_reason ?? undefined}
                  onclick={(e) => handleRowClick(e, child, cat.id)}
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
        {/if}
      {/each}

      <!-- Total -->
      <div class="flex items-center gap-1 text-sm py-1 select-none">
        <span class="flex shrink-0 w-4"></span>
        <span class="text-default-800 font-medium flex-1">Total</span>
        <span class="text-default-500 text-xs font-bold tabular-nums shrink-0">
          {formatBytes(tree.total_size)}
        </span>
      </div>
    {/if}
  </div>
</FieldCard>
