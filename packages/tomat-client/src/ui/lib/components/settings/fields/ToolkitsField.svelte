<script lang="ts">
  import { onMount } from "svelte";
  import {
    BUILTIN_TOOLKIT_ID,
    errMessage,
    type Toolkit,
    type ToolkitSearchResult,
  } from "@tomat/shared";
  import { confirmState, toolkitsState } from "$lib/state";
  import { cores } from "$lib/core";
  import type { ParsedQuery } from "$lib/shared/object-query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/shared/object-menu";
  import type { Badge } from "$lib/components/ui/object-types.ts";
  import ObjectManager from "$lib/components/ui/ObjectManager.svelte";
  import ObjectCard from "$lib/components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "$lib/components/ui/ObjectDetailHeader.svelte";
  import ToolkitDetail from "./ToolkitDetail.svelte";

  // A list row is either an installed toolkit or an npm search result. A single
  // load returns one kind (installed XOR npm), so ids never collide.
  type ToolkitItem =
    | { kind: "installed"; toolkit: Toolkit }
    | { kind: "npm"; result: ToolkitSearchResult; installed: boolean };

  let query = $state("");
  let selectedItem = $state<ToolkitItem | null>(null);
  let reloadKey = $state(0);
  // True while "Check for Updates" runs; swaps the triple-dot for a spinner.
  let checking = $state(false);

  onMount(() => void toolkitsState.ensureConnected());

  function isUpdatable(tk: Toolkit): boolean {
    return toolkitsState.updateStatus[tk.id]?.updateAvailable ?? false;
  }

  function statusBadge(tk: Toolkit): Badge {
    if (tk.status === "drift") {
      return {
        label: "Content changed",
        accent: "red",
        title: tk.lastError ?? "Files changed on disk since install; review and re-enable.",
      };
    }
    if (tk.lastError) return { label: "Error", accent: "red", title: tk.lastError };
    if (isUpdatable(tk)) {
      const latest = toolkitsState.updateStatus[tk.id]?.latestVersion;
      return { label: "Update available", accent: "yellow", title: latest ? `v${latest}` : undefined };
    }
    if (tk.status === "downloaded") return { label: "Install to enable", accent: "yellow" };
    return { label: "Installed", accent: "green" };
  }

  function updateRow(tk: Toolkit): MenuRow {
    const latest = toolkitsState.updateStatus[tk.id]?.latestVersion;
    return {
      id: "update",
      label: latest ? `Update to v${latest}` : "Update",
      onSelect: async () => {
        try {
          await toolkitsState.updateToolkit(tk.id);
        } catch (e) {
          confirmState.alert({ title: "Update failed", message: errMessage(e) });
        }
      },
    };
  }

  // Toolkit ids flatten an npm `@scope/name` to `@scope__name`.
  function isInstalled(name: string): boolean {
    return toolkitsState.installed.some((t) => t.id === name || t.id === name.replace("/", "__"));
  }

  function isInstalling(name: string): boolean {
    return Object.values(toolkitsState.installJobs).some(
      (j) => j.status === "running" && j.label === name,
    );
  }

  // Phase 2 action for a downloaded toolkit: install its deps so its tools can
  // be enabled. (Per-tool enable lives in the detail view.)
  function installRow(tk: Toolkit): MenuRow {
    return {
      id: "install",
      label: "Install",
      onSelect: async () => {
        try {
          await toolkitsState.installDeps(tk.id);
        } catch (e) {
          confirmState.alert({ title: "Install failed", message: errMessage(e) });
        }
      },
    };
  }

  function reenableRow(tk: Toolkit): MenuRow {
    return { id: "reenable", label: "Review & re-enable", onSelect: () => confirmReenable(tk) };
  }

  // Drift confirm: the user reviewed the on-disk change and trusts it. Re-pins
  // the hash and returns the toolkit to installed; its tools stay disabled.
  function confirmReenable(tk: Toolkit, after?: () => void) {
    confirmState.request({
      title: "Content changed",
      message:
        `"${tk.displayName || tk.id}" files changed on disk since it was installed. ` +
        `Re-enabling trusts the current on-disk contents and re-pins its hash. Only continue ` +
        `if you made this change. Its tools stay disabled until you re-enable them.`,
      destructive: true,
      confirmLabel: "Trust and re-enable",
      onConfirm: async () => {
        try {
          await toolkitsState.confirmReenable(tk.id);
          after?.();
        } catch (e) {
          confirmState.alert({ title: "Re-enable failed", message: errMessage(e) });
        }
      },
    });
  }

  function uninstall(tk: Toolkit, after?: () => void) {
    confirmState.request({
      title: "Uninstall toolkit",
      message:
        `Remove "${tk.displayName || tk.id}" v${tk.version}? Its grants and installed files will be deleted.`,
      destructive: true,
      confirmLabel: "Uninstall",
      onConfirm: async () => {
        try {
          await toolkitsState.uninstall(tk.id);
          after?.();
        } catch (e) {
          confirmState.alert({ title: "Uninstall failed", message: errMessage(e) });
        }
      },
    });
  }

  function cardMenuRows(item: ToolkitItem): MenuRow[] {
    if (item.kind === "installed") {
      const tk = item.toolkit;
      const rows: MenuRow[] = [];
      if (tk.status === "downloaded") rows.push(installRow(tk));
      if (tk.status === "drift") rows.push(reenableRow(tk));
      if (isUpdatable(tk)) rows.push(updateRow(tk));
      rows.push({ id: "uninstall", label: "Uninstall", onSelect: () => uninstall(tk) });
      return rows;
    }
    if (item.installed || isInstalling(item.result.name)) return [];
    return [
      {
        id: "download",
        label: "Download",
        onSelect: async () => {
          try {
            await toolkitsState.download({ source: "npm", name: item.result.name });
          } catch (e) {
            confirmState.alert({ title: "Download failed", message: errMessage(e) });
          }
        },
      },
    ];
  }

  function npmMeta(result: ToolkitSearchResult): string {
    return [
      `v${result.version}`,
      result.weeklyDownloads !== undefined
        ? `${result.weeklyDownloads.toLocaleString()} weekly downloads`
        : null,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ");
  }

  function npmBadges(result: ToolkitSearchResult, installed: boolean): Badge[] {
    if (installed) return [{ label: "Installed", accent: "green" }];
    if (isInstalling(result.name)) return [{ label: "Installing", accent: "yellow" }];
    return [];
  }

  async function load({ query: q, offset, limit }: {
    offset: number;
    limit: number;
    query: ParsedQuery;
  }): Promise<{ items: ToolkitItem[]; done: boolean }> {
    // Pull a fresh installed list first: it backs both the installed view and
    // the npm view's "Installed" flag, decoupled from the WS refresh timing.
    await toolkitsState.refresh();

    if (q.filters.has("npm")) {
      const text = q.text.trim();
      if (!text) return { items: [], done: true };
      const res = await cores().api().toolkits.search(text, { offset, limit });
      const items: ToolkitItem[] = res.results.map((result) => ({
        kind: "npm",
        result,
        installed: isInstalled(result.name),
      }));
      return { items, done: res.results.length < limit };
    }

    const text = q.text.toLowerCase();
    let list = toolkitsState.installed.filter(
      (t) =>
        !text ||
        (t.displayName || t.id).toLowerCase().includes(text) ||
        (t.description ?? "").toLowerCase().includes(text),
    );
    // `@update-available` narrows to toolkits a prior check flagged.
    if (q.filters.has("update-available")) {
      list = list.filter((t) => isUpdatable(t));
    }
    // `downloads` is meaningful only for npm; installed falls back to name.
    if (q.sort === "name" || q.sort === "downloads") {
      list = [...list].sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
    }
    return { items: list.map((toolkit) => ({ kind: "installed", toolkit })), done: true };
  }

  function detailActions(tk: Toolkit, close: () => void) {
    const actions = [];
    if (tk.status === "downloaded") {
      actions.push({
        label: "Install",
        icon: "i-material-symbols-download-rounded",
        onSelect: () => installRow(tk).onSelect(),
      });
    }
    if (tk.status === "drift") {
      actions.push({
        label: "Review & re-enable",
        icon: "i-material-symbols-warning-outline-rounded",
        onSelect: () => confirmReenable(tk, close),
      });
    }
    if (isUpdatable(tk)) {
      const latest = toolkitsState.updateStatus[tk.id]?.latestVersion;
      actions.push({
        label: latest ? `Update to v${latest}` : "Update",
        icon: "i-material-symbols-upgrade-rounded",
        onSelect: () => updateRow(tk).onSelect(),
      });
    }
    actions.push({
      label: "Uninstall",
      icon: "i-material-symbols-delete-outline-rounded",
      variant: "danger" as const,
      onSelect: () => uninstall(tk, close),
    });
    return actions;
  }
</script>

<ObjectManager
  {load}
  idOf={(item) => (item.kind === "installed" ? item.toolkit.id : item.result.name)}
  getById={(id): ToolkitItem | undefined => {
    const toolkit = toolkitsState.installed.find((t) => t.id === id);
    return toolkit ? { kind: "installed", toolkit } : undefined;
  }}
  searchPlaceholder="Search toolkits"
  subscribe={(onChange) =>
    cores().subscribeWs((f) => {
      if (f.kind === "toolkit.snapshot" || f.kind === "toolkit.install_done") onChange();
    })}
  bind:query
  bind:selectedItem
  bind:reloadKey
  hasFilterSort
  onFilterSort={() =>
    showFilterSortMenu({
      filters: [
        { label: "Source", options: [{ token: "installed", label: "Installed" }, { token: "npm", label: "npm Marketplace" }] },
        { label: "Status", options: [{ token: "update-available", label: "Update available" }] },
      ],
      sorts: [
        { value: "name", label: "Name" },
        { value: "downloads", label: "Downloads" },
      ],
      query,
      onQueryChange: (q) => (query = q),
    })}
  hasMenu
  menuBusy={checking}
  onMenu={() => {
    const rows: MenuRow[] = [
      {
        id: "check-updates",
        label: "Check for Updates",
        onSelect: async () => {
          checking = true;
          try {
            await toolkitsState.checkUpdates();
            // Narrow to the installed toolkits that have an update available.
            query = "@installed @update-available";
            reloadKey++;
          } catch (e) {
            confirmState.alert({ title: "Check for updates failed", message: errMessage(e) });
          } finally {
            checking = false;
          }
        },
      },
    ];
    if (!toolkitsState.isBuiltinInstalled && !isInstalling(BUILTIN_TOOLKIT_ID)) {
      rows.push({
        id: "download-builtin",
        label: "Download built-in toolkit",
        onSelect: async () => {
          try {
            await toolkitsState.downloadBuiltin();
          } catch (e) {
            confirmState.alert({ title: "Download failed", message: errMessage(e) });
          }
        },
      });
    }
    rows.push({
      id: "rescan",
      label: "Rescan Local Toolkits",
      onSelect: async () => {
        try {
          await toolkitsState.rescan();
          // Reindexing is part of a rescan, not its own action: new/changed
          // tools must be re-embedded for relevance. If it fails, so does the
          // rescan.
          await toolkitsState.reindex();
          reloadKey++;
        } catch (e) {
          confirmState.alert({ title: "Rescan failed", message: errMessage(e) });
        }
      },
    });
    showObjectActionMenu(rows);
  }}
>
  {#snippet card(item, open)}
    {#if item.kind === "installed"}
      <ObjectCard
        label={item.toolkit.displayName || item.toolkit.id}
        description={item.toolkit.description}
        meta={`v${item.toolkit.version}`}
        badges={[statusBadge(item.toolkit)]}
        menuRows={cardMenuRows(item)}
        onOpen={open}
      />
    {:else}
      <ObjectCard
        label={item.result.name}
        description={item.result.description}
        meta={npmMeta(item.result)}
        badges={npmBadges(item.result, item.installed)}
        menuRows={cardMenuRows(item)}
      />
    {/if}
  {/snippet}
  {#snippet detail(item, close)}
    {#if item.kind === "installed"}
      {@const tk = item.toolkit}
      <ObjectDetailHeader
        title={tk.displayName || tk.id}
        subtitle={`v${tk.version} · ${tk.source}`}
        badges={[statusBadge(tk)]}
        actions={detailActions(tk, close)}
      />
      <div class="tomat-scroll flex-1 min-h-0 overflow-y-auto">
        <ToolkitDetail toolkit={tk} />
      </div>
    {/if}
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.includes("@npm")}
        {#if query.replace(/@npm/g, "").trim()}
          <div class="text-base text-default-700">No npm packages found</div>
        {:else}
          <div class="text-base text-default-700">Search the npm marketplace</div>
          <div class="text-sm text-default-500">Type a package name to search.</div>
        {/if}
      {:else if query.trim()}
        <div class="text-base text-default-700">No matching toolkits</div>
      {:else}
        <div class="text-base text-default-700">No toolkits installed</div>
        <div class="text-sm text-default-500">Add @npm to search the marketplace.</div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
