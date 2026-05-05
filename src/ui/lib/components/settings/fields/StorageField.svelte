<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { SECRET_KEYS, type SettingField } from "$lib/shared/settings";
  import { formatBytes } from "$lib/shared/format";
  import {
    collectModelFiles,
    collectPaths,
    computeLockReasons,
    expandToFiles,
    findNode,
    isSnippetPath,
    visibleRows,
    type StorageNode,
    type StorageTree,
  } from "$lib/shared/storageTree";
  import { confirmState, settingsState, snippetsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let { field } = $props<{ field: SettingField }>();

  let tree = $state<StorageTree | null>(null);
  let expanded = $state<Set<string>>(new Set());
  let selected = $state<Set<string>>(new Set());
  let lastSelectedPath = $state<string | null>(null);
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTarget = $state<StorageNode | null>(null);
  // Maps every locked path (file paths from settings + folder paths whose
  // entire subtree is locked) to a human-readable reason. `.has(p)` answers
  // "is this row locked?", `.get(p)` gives the tooltip text.
  const lockReasons = $derived(
    tree ? computeLockReasons(tree, settingsState.currentSettings) : new Map<string, string>(),
  );

  async function refresh() {
    try {
      tree = (await invoke("list_tomat_storage")) as StorageTree;
      // Drop selections for paths that no longer exist
      const allPaths = new Set<string>();
      if (tree) {
        for (const n of [...tree.models, ...tree.sessions, ...tree.snippets]) {
          collectPaths(n, allPaths);
        }
      }
      const next = new Set<string>();
      for (const p of selected) if (allPaths.has(p)) next.add(p);
      selected = next;
    } catch (e) {
      console.warn("list_tomat_storage failed", e);
    }
  }

  onMount(() => {
    refresh();
  });

  function toggleExpand(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function handleRowClick(e: MouseEvent, node: StorageNode) {
    if (lockReasons.has(node.path)) {
      // Locked rows aren't selectable, but locked folders are still
      // expandable so users can inspect the protected files inside.
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
      // Plain click on a folder toggles its expansion as well, so the user
      // can drill into a model repo without aiming for the chevron.
      if (node.kind === "folder") toggleExpand(path);
    }
    selected = next;
    lastSelectedPath = path;
  }

  function hasClearable(
    kind: "models" | "sessions" | "snippets" | "settings",
  ): boolean {
    if (!tree) return false;
    if (kind === "settings") return tree.settings_size > 0;
    if (kind === "sessions") return tree.sessions.length > 0;
    if (kind === "snippets") return tree.snippets.length > 0;
    return collectModelFiles(tree).some((p) => !lockReasons.has(p));
  }

  async function revealPath(path: string) {
    try {
      await invoke("reveal_tomat_path", { path });
    } catch (err) {
      console.warn("reveal_tomat_path failed", err);
    }
  }

  function rootPathFor(
    kind: "models" | "sessions" | "snippets" | "settings",
  ): string | null {
    if (!tree) return null;
    if (kind === "settings") return `${tree.root_path}/settings.json`;
    return `${tree.root_path}/${kind}`;
  }

  function deleteSelectionCounts(): { files: number; folders: number } {
    let files = 0;
    let folders = 0;
    if (!tree) return { files, folders };
    for (const p of selected) {
      if (lockReasons.has(p)) continue;
      const n = findNode(tree, p);
      if (!n) continue;
      if (n.kind === "file") files += 1;
      else folders += 1;
    }
    return { files, folders };
  }

  function deleteLabel(): string | null {
    const { files, folders } = deleteSelectionCounts();
    if (files === 0 && folders === 0) return null;
    const parts: string[] = [];
    if (folders > 0) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
    return `Delete ${parts.join(" and ")}`;
  }

  function fileManagerName(): string {
    if (typeof navigator === "undefined") return "file manager";
    if (/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)) return "Finder";
    if (/Win/i.test(navigator.userAgent)) return "Explorer";
    return "file manager";
  }

  function showInLabel(): string {
    return `Show in ${fileManagerName()}`;
  }

  function deleteSelected() {
    if (selected.size === 0 || !tree) return;
    const all = expandToFiles(tree, [...selected]);
    const toDelete = all.filter((p) => !lockReasons.has(p));
    const skipped = all.length - toDelete.length;
    if (toDelete.length === 0) {
      confirmState.request({
        title: "Delete items",
        message:
          "No items to delete - the selection only contains files currently in use.",
        confirmLabel: "OK",
        onConfirm: () => {},
      });
      return;
    }
    const suffix =
      skipped > 0
        ? ` ${skipped} file${skipped === 1 ? "" : "s"} currently in use will be kept.`
        : "";
    const { files, folders } = deleteSelectionCounts();
    const totalSize = toDelete.reduce(
      (sum, p) => sum + (findNode(tree!, p)?.size ?? 0),
      0,
    );
    const parts: string[] = [];
    if (folders > 0)
      parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
    const summary = parts.join(" and ");
    const touchesSnippets = toDelete.some((p) => isSnippetPath(tree!, p));
    confirmState.request({
      title: "Delete items",
      message: `Delete ${summary} (${formatBytes(totalSize)}) from disk?${suffix} This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await invoke("delete_tomat_paths", { paths: toDelete });
        } catch (err) {
          console.error("delete_tomat_paths failed", err);
        }
        await refresh();
        if (touchesSnippets) {
          void snippetsState.load();
        }
      },
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    const isDelete =
      e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey));
    if (isDelete && selected.size > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }

  function openContextMenu(e: MouseEvent, node: StorageNode) {
    e.preventDefault();
    // Match standard file-manager behavior: right-clicking outside the
    // current selection moves the cursor onto the clicked row. Locked rows
    // can't be selected, so we just clear instead.
    if (lockReasons.has(node.path)) {
      selected = new Set();
      lastSelectedPath = null;
    } else if (!selected.has(node.path)) {
      selected = new Set([node.path]);
      lastSelectedPath = node.path;
    }
    menuTarget = node;
    menuX = e.clientX;
    menuY = e.clientY;
    menuOpen = true;
  }

  function closeContextMenu() {
    menuOpen = false;
    menuTarget = null;
  }

  function menuDelete() {
    closeContextMenu();
    deleteSelected();
  }

  function menuReveal() {
    const target = menuTarget;
    closeContextMenu();
    if (target) revealPath(target.path);
  }

  function requestClear(kind: "models" | "sessions" | "snippets" | "settings") {
    if (kind === "models") {
      if (!tree) return;
      const all = collectModelFiles(tree);
      const toDelete = all.filter((p) => !lockReasons.has(p));
      const skipped = all.length - toDelete.length;
      if (toDelete.length === 0) {
        confirmState.request({
          title: "Clear models",
          message:
            "No models to clear - the remaining files are currently in use.",
          confirmLabel: "OK",
          onConfirm: () => {},
        });
        return;
      }
      const suffix =
        skipped > 0
          ? ` ${skipped} file${skipped === 1 ? "" : "s"} currently in use will be kept.`
          : "";
      confirmState.request({
        title: "Clear models",
        message: `Delete ${toDelete.length} model file${toDelete.length === 1 ? "" : "s"} from disk?${suffix} This cannot be undone.`,
        destructive: true,
        confirmLabel: "Clear",
        onConfirm: async () => {
          try {
            await invoke("delete_tomat_paths", { paths: toDelete });
          } catch (err) {
            console.error("clear models failed", err);
          }
          await refresh();
        },
      });
      return;
    }

    if (kind === "snippets") {
      const paths = tree?.snippets.map((n) => n.path) || [];
      if (paths.length === 0) return;
      confirmState.request({
        title: "Clear snippets",
        message: `Delete all ${paths.length} snippet${paths.length === 1 ? "" : "s"} from disk? This cannot be undone.`,
        destructive: true,
        confirmLabel: "Clear",
        onConfirm: async () => {
          try {
            await invoke("delete_tomat_paths", { paths });
          } catch (err) {
            console.error("clear snippets failed", err);
          }
          await refresh();
          void snippetsState.load();
        },
      });
      return;
    }

    const title = kind === "settings" ? "Reset settings" : "Clear sessions";
    const message =
      kind === "settings"
        ? "Reset all settings to their defaults? This cannot be undone."
        : "Remove all sessions from disk? This cannot be undone.";
    confirmState.request({
      title,
      message,
      destructive: true,
      confirmLabel: kind === "settings" ? "Reset" : "Clear",
      onConfirm: async () => {
        try {
          if (kind === "sessions") {
            await invoke("clear_tomat_sessions");
          } else {
            await invoke("clear_tomat_settings", { secretKeys: SECRET_KEYS });
            await settingsState.loadSettings();
          }
        } catch (err) {
          console.error(`clear ${kind} failed`, err);
        }
        await refresh();
      },
    });
  }
</script>

<FieldCard {field}>
  <div
    class="flex flex-col gap-2 outline-none"
    tabindex="0"
    role="tree"
    onkeydown={handleKeyDown}
  >
    <!-- Tree -->
    {#if tree}
      {@const rootGroups = [
        {
          key: "__models__",
          label: "Models",
          empty: "No models.",
          size: tree.models_size,
          nodes: tree.models,
          clear: "models" as const,
          expandable: true,
        },
        {
          key: "__sessions__",
          label: "Sessions",
          empty: "No sessions.",
          size: tree.sessions_size,
          nodes: tree.sessions,
          clear: "sessions" as const,
          expandable: true,
        },
        {
          key: "__snippets__",
          label: "Snippets",
          empty: "No snippets.",
          size: tree.snippets_size,
          nodes: tree.snippets,
          clear: "snippets" as const,
          expandable: true,
        },
        {
          key: "__settings__",
          label: "Settings",
          empty: "",
          size: tree.settings_size,
          nodes: [] as StorageNode[],
          clear: "settings" as const,
          expandable: false,
        },
      ]}
      {#each rootGroups as group (group.key)}
        <div class="flex flex-col">
          <!-- Group header row -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group flex items-center gap-1 text-left text-sm py-1 select-none {group.expandable
              ? 'cursor-pointer'
              : ''}"
            onclick={() => group.expandable && toggleExpand(group.key)}
          >
            {#if group.expandable}
              <i
                class="flex shrink-0 w-4 justify-center text-default-500 {expanded.has(
                  group.key,
                )
                  ? 'i-material-symbols-expand-more-rounded'
                  : 'i-material-symbols-chevron-right-rounded'}"
              ></i>
            {:else}
              <span class="flex shrink-0 w-4"></span>
            {/if}
            <span class="text-default-800 font-medium truncate"
              >{group.label}</span
            >
            <button
              class="flex shrink-0 w-5 h-5 justify-center items-center text-default-500 hover:text-default-900 hover:cursor-pointer transition-colors"
              aria-label={`Open ${group.label} in ${fileManagerName()}`}
              title={`Open ${group.label} in ${fileManagerName()}`}
              onclick={(e) => {
                e.stopPropagation();
                const p = rootPathFor(group.clear);
                if (p) revealPath(p);
              }}
            >
              <i class="flex i-material-symbols-folder-open-rounded"></i>
            </button>
            {#if hasClearable(group.clear)}
              <button
                class="flex shrink-0 w-5 h-5 -ml-1 justify-center items-center text-default-500 hover:text-default-900 hover:cursor-pointer transition-colors"
                aria-label={group.clear === "settings"
                  ? `Reset ${group.label}`
                  : `Clear ${group.label}`}
                title={group.clear === "settings"
                  ? `Reset ${group.label}`
                  : `Clear ${group.label}`}
                onclick={(e) => {
                  e.stopPropagation();
                  requestClear(group.clear);
                }}
              >
                <i class="flex i-material-symbols-delete-outline-rounded"></i>
              </button>
            {/if}
            <span class="flex-1"></span>
            <span class="text-default-500 text-xs tabular-nums shrink-0"
              >{formatBytes(group.size)}</span
            >
          </div>

          {#if group.expandable && expanded.has(group.key)}
            {#if group.nodes.length === 0}
              <div class="pl-5 text-default-400 text-xs py-1 select-none">
                {group.empty}
              </div>
            {:else}
              {#each group.nodes as node (node.path)}
                {@const lockReason = lockReasons.get(node.path) ?? null}
                {@const isLocked = lockReason !== null}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="flex items-center gap-1 text-sm pl-2 py-1 select-none {isLocked
                    ? node.kind === 'folder'
                      ? 'cursor-pointer opacity-60'
                      : 'cursor-default opacity-60'
                    : 'cursor-pointer'} {selected.has(node.path)
                    ? 'bg-default-400'
                    : ''}"
                  title={lockReason ?? undefined}
                  onclick={(e) => handleRowClick(e, node)}
                  oncontextmenu={(e) => openContextMenu(e, node)}
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
                  <span class="flex-1 truncate text-default-800"
                    >{node.name}</span
                  >
                  <span class="text-default-500 text-xs tabular-nums shrink-0"
                    >{formatBytes(node.size)}</span
                  >
                </div>
                {#if node.kind === "folder" && expanded.has(node.path)}
                  {#each node.children as child (child.path)}
                    {@const childLockReason =
                      lockReasons.get(child.path) ?? null}
                    {@const childLocked = childLockReason !== null}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="flex items-center gap-1 text-sm pl-8 py-1 select-none {childLocked
                        ? 'cursor-default opacity-60'
                        : 'cursor-pointer'} {selected.has(child.path)
                        ? 'bg-default-400'
                        : ''}"
                      title={childLockReason ?? undefined}
                      onclick={(e) => handleRowClick(e, child)}
                      oncontextmenu={(e) => openContextMenu(e, child)}
                    >
                      <span class="flex shrink-0 w-4"></span>
                      <i
                        class="flex shrink-0 w-4 justify-center {childLocked
                          ? 'i-material-symbols-lock-outline'
                          : 'i-material-symbols-description-outline-rounded'} text-default-500"
                      ></i>
                      <span class="flex-1 truncate text-default-800"
                        >{child.name}</span
                      >
                      <span
                        class="text-default-500 text-xs tabular-nums shrink-0"
                        >{formatBytes(child.size)}</span
                      >
                    </div>
                  {/each}
                {/if}
              {/each}
            {/if}
          {/if}
        </div>
      {/each}

      <!-- Total row mirrors a root-group header (same paddings, font weight,
         and size-text color) so it reads as the bottom summary of the list. -->
      <div class="flex items-center gap-1 text-sm py-1 select-none">
        <span class="flex shrink-0 w-4"></span>
        <span class="text-default-800 font-medium truncate">Total</span>
        <span class="flex-1"></span>
        <span class="text-default-500 text-xs font-bold tabular-nums shrink-0">
          {formatBytes(tree.total_size)}
        </span>
      </div>
    {:else}
      <div class="text-default-500 text-sm">Loading…</div>
    {/if}
    <div class="flex items-center justify-end gap-2 mb-1">
      <button
        type="button"
        class="flex items-center gap-1 bg-default-300 hover:bg-default-400 text-default-800 rounded-xl px-3 h-8 text-sm hover:cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none"
        onclick={() => requestClear("models")}
        disabled={!hasClearable("models")}
        title="Delete model files that aren't currently in use"
      >
        <i class="flex i-material-symbols-delete-outline-rounded"></i>
        <span>Clear Unused</span>
      </button>
      <button
        type="button"
        class="flex items-center gap-1 bg-default-300 hover:bg-default-400 text-default-800 rounded-xl px-3 h-8 text-sm hover:cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none"
        onclick={() => tree && revealPath(tree.root_path)}
        title={`Open Storage in ${fileManagerName()}`}
      >
        <i class="flex i-material-symbols-folder-open-rounded"></i>
        <span>Open Folder</span>
      </button>
    </div>
  </div>
</FieldCard>

{#if menuOpen}
  {@const dLabel = deleteLabel()}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50"
    onclick={closeContextMenu}
    oncontextmenu={(e) => {
      e.preventDefault();
      closeContextMenu();
    }}
  >
    <div
      class="absolute bg-default-300 rounded-md shadow-lg py-1 min-w-[200px] text-sm select-none"
      style="left: {menuX}px; top: {menuY}px;"
    >
      {#if dLabel}
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-accent-red-600 hover:bg-default-400 hover:cursor-pointer transition-colors"
          onclick={menuDelete}
        >
          <i class="flex i-material-symbols-delete-outline-rounded"></i>
          <span>{dLabel}</span>
        </button>
      {/if}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-default-800 hover:bg-default-400 hover:cursor-pointer transition-colors"
        onclick={menuReveal}
      >
        <i class="flex i-material-symbols-folder-open-rounded"></i>
        <span>{showInLabel()}</span>
      </button>
    </div>
  </div>
{/if}
