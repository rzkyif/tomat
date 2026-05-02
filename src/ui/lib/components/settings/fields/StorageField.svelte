<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    SECRET_KEYS,
    TTS_BASE_FILES,
    type SettingField,
  } from "$lib/shared/settings";
  import { confirmState, settingsState, snippetsState } from "../../../state";
  import FieldDescription from "./FieldDescription.svelte";

  let { field } = $props<{ field: SettingField }>();

  type StorageFile = {
    kind: "file";
    name: string;
    path: string;
    size: number;
  };
  type StorageFolder = {
    kind: "folder";
    name: string;
    path: string;
    size: number;
    children: StorageNode[];
  };
  type StorageNode = StorageFile | StorageFolder;
  type StorageTree = {
    models: StorageNode[];
    sessions: StorageNode[];
    snippets: StorageNode[];
    total_size: number;
    models_size: number;
    sessions_size: number;
    snippets_size: number;
    settings_size: number;
    root_path: string;
  };

  let tree = $state<StorageTree | null>(null);
  let expanded = $state<Set<string>>(new Set());
  let selected = $state<Set<string>>(new Set());
  let lastSelectedPath = $state<string | null>(null);
  const inUsePaths = $derived(getInUseModelPaths());

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

  function collectPaths(node: StorageNode, into: Set<string>) {
    into.add(node.path);
    if (node.kind === "folder") {
      for (const c of node.children) collectPaths(c, into);
    }
  }

  onMount(() => {
    refresh();
  });

  function formatBytes(b: number): string {
    if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
    if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  function toggleExpand(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  // Flat list of visible rows (respecting expansion) for range selection
  function visibleRows(): StorageNode[] {
    if (!tree) return [];
    const rows: StorageNode[] = [];
    const addRoot = (rootKey: string, nodes: StorageNode[]) => {
      if (!expanded.has(rootKey)) return;
      for (const n of nodes) {
        rows.push(n);
        if (n.kind === "folder" && expanded.has(n.path)) {
          for (const c of n.children) rows.push(c);
        }
      }
    };
    addRoot("__models__", tree.models);
    addRoot("__sessions__", tree.sessions);
    addRoot("__snippets__", tree.snippets);
    return rows;
  }

  function handleRowClick(e: MouseEvent, node: StorageNode) {
    if (inUsePaths.has(node.path)) return;
    const path = node.path;
    const next = new Set(selected);
    if (e.shiftKey && lastSelectedPath) {
      const rows = visibleRows()
        .map((r) => r.path)
        .filter((p) => !inUsePaths.has(p));
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
    }
    selected = next;
    lastSelectedPath = path;
  }

  /** Convert a HuggingFace-style path (@user/repo/branch/file) to the on-disk path. */
  function resolveHfToDisk(hfPath: unknown, rootPath: string): string | null {
    if (typeof hfPath !== "string" || !hfPath.startsWith("@")) return null;
    const parts = hfPath.slice(1).split("/");
    if (parts.length < 4) return null;
    const user = parts[0];
    const repo = parts[1];
    const rest = parts.slice(3).join("/");
    return `${rootPath}/models/${user}/${repo}/${rest}`;
  }

  function getInUseModelPaths(): Set<string> {
    const protect = new Set<string>();
    if (!tree) return protect;
    const s = settingsState.currentSettings;
    if (s["llm.provider"] !== "external") {
      const p = resolveHfToDisk(s["llm.modelPath"], tree.root_path);
      if (p) protect.add(p);
      if (s["llm.supportImages"]) {
        const m = resolveHfToDisk(s["llm.mmprojPath"], tree.root_path);
        if (m) protect.add(m);
      }
    }
    if (s["stt.enabled"] && s["stt.provider"] !== "external") {
      const p = resolveHfToDisk(s["stt.modelPath"], tree.root_path);
      if (p) protect.add(p);
    }
    // TTS has no "external" mode - whenever it's enabled, the Kokoro model
    // + tokenizer files are required. Protect every path from TTS_BASE_FILES
    // so "Clear models" leaves them alone.
    if (s["tts.enabled"]) {
      for (const hf of TTS_BASE_FILES) {
        const p = resolveHfToDisk(hf, tree.root_path);
        if (p) protect.add(p);
      }
    }
    return protect;
  }

  function collectModelFiles(): string[] {
    if (!tree) return [];
    const out: string[] = [];
    for (const n of tree.models) {
      if (n.kind === "file") out.push(n.path);
      else for (const c of n.children) if (c.kind === "file") out.push(c.path);
    }
    return out;
  }

  function hasClearable(
    kind: "models" | "sessions" | "snippets" | "settings",
  ): boolean {
    if (!tree) return false;
    if (kind === "settings") return tree.settings_size > 0;
    if (kind === "sessions") return tree.sessions.length > 0;
    if (kind === "snippets") return tree.snippets.length > 0;
    return collectModelFiles().some((p) => !inUsePaths.has(p));
  }

  function findNode(path: string): StorageNode | null {
    if (!tree) return null;
    for (const root of [tree.models, tree.sessions, tree.snippets]) {
      for (const n of root) {
        if (n.path === path) return n;
        if (n.kind === "folder") {
          for (const c of n.children) if (c.path === path) return c;
        }
      }
    }
    return null;
  }

  function expandToFiles(paths: string[]): string[] {
    const files: string[] = [];
    for (const p of paths) {
      const n = findNode(p);
      if (!n) continue;
      if (n.kind === "file") files.push(n.path);
      else {
        for (const c of n.children) {
          if (c.kind === "file") files.push(c.path);
        }
      }
    }
    return files;
  }

  function isSnippetPath(path: string): boolean {
    return !!tree && tree.snippets.some((n) => n.path === path);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const isDelete =
      e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey));
    if (isDelete && selected.size > 0) {
      e.preventDefault();
      const all = expandToFiles([...selected]);
      const toDelete = all.filter((p) => !inUsePaths.has(p));
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
      const touchesSnippets = toDelete.some(isSnippetPath);
      confirmState.request({
        title: "Delete items",
        message: `Delete ${toDelete.length} file${toDelete.length === 1 ? "" : "s"} from disk?${suffix} This cannot be undone.`,
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
  }

  function requestClear(kind: "models" | "sessions" | "snippets" | "settings") {
    if (kind === "models") {
      const protect = getInUseModelPaths();
      const all = collectModelFiles();
      const toDelete = all.filter((p) => !protect.has(p));
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

<div
  class="flex flex-col gap-2 px-4 pt-2 pb-3 bg-default-200 rounded-2xl border-2 border-transparent outline-none"
  tabindex="0"
  role="tree"
  onkeydown={handleKeyDown}
>
  <div class="flex flex-col">
    <div class="text-default-800">{field.name}</div>
    {#if field.description}
      <FieldDescription text={field.description} />
    {/if}
  </div>

  <!-- Header: total only -->
  <div class="flex items-center bg-default-300 rounded-xl px-3 py-2 mb-1">
    <span class="text-default-800 text-sm flex-1">Total</span>
    <span class="text-default-800 text-sm tabular-nums">
      {tree ? formatBytes(tree.total_size) : "…"}
    </span>
  </div>

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
          class="group flex items-center gap-1 text-left text-sm px-2 py-1 rounded-lg {group.expandable
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
          <span class="flex-1"></span>
          {#if hasClearable(group.clear)}
            <button
              class="flex shrink-0 w-5 h-5 justify-center items-center text-default-500 hover:text-default-900 hover:cursor-pointer transition-colors opacity-0 group-hover:opacity-100"
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
          <span class="text-default-500 text-xs tabular-nums shrink-0"
            >{formatBytes(group.size)}</span
          >
        </div>

        {#if group.expandable && expanded.has(group.key)}
          {#if group.nodes.length === 0}
            <div class="pl-7 text-default-400 text-xs py-1">{group.empty}</div>
          {:else}
            {#each group.nodes as node (node.path)}
              {@const isProtected = inUsePaths.has(node.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="flex items-center gap-1 text-sm pl-4 pr-2 py-1 rounded-lg {isProtected
                  ? 'cursor-default opacity-60'
                  : 'cursor-pointer'} {selected.has(node.path)
                  ? 'bg-blue-500/20'
                  : ''}"
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
                  class="flex shrink-0 w-4 justify-center {isProtected
                    ? 'i-material-symbols-lock-outline'
                    : node.kind === 'folder'
                      ? 'i-material-symbols-folder-outline-rounded'
                      : 'i-material-symbols-description-outline-rounded'} text-default-500"
                ></i>
                <span class="flex-1 truncate text-default-800">{node.name}</span
                >
                {#if node.kind !== "folder" || !expanded.has(node.path)}
                  <span class="text-default-500 text-xs tabular-nums shrink-0"
                    >{formatBytes(node.size)}</span
                  >
                {/if}
              </div>
              {#if node.kind === "folder" && expanded.has(node.path)}
                {#each node.children as child (child.path)}
                  {@const childProtected = inUsePaths.has(child.path)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="flex items-center gap-1 text-sm pl-10 pr-2 py-1 rounded-lg {childProtected
                      ? 'cursor-default opacity-60'
                      : 'cursor-pointer'} {selected.has(child.path)
                      ? 'bg-blue-500/20'
                      : ''}"
                    onclick={(e) => handleRowClick(e, child)}
                  >
                    <span class="flex shrink-0 w-4"></span>
                    <i
                      class="flex shrink-0 w-4 justify-center {childProtected
                        ? 'i-material-symbols-lock-outline'
                        : 'i-material-symbols-description-outline-rounded'} text-default-500"
                    ></i>
                    <span class="flex-1 truncate text-default-800"
                      >{child.name}</span
                    >
                    <span class="text-default-500 text-xs tabular-nums shrink-0"
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
  {:else}
    <div class="text-default-500 text-sm">Loading…</div>
  {/if}
</div>
