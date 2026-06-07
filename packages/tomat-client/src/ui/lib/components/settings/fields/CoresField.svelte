<script lang="ts">
  import { errMessage } from "@tomat/shared";
  import { cores, type PairedCoreEntry } from "$lib/core";
  import { confirmState, viewState } from "$lib/state";
  import type { ParsedQuery } from "$lib/shared/object-query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/shared/object-menu";
  import ObjectManager from "$lib/components/ui/ObjectManager.svelte";
  import ObjectCard from "$lib/components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "$lib/components/ui/ObjectDetailHeader.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Input from "$lib/components/ui/Input.svelte";

  let query = $state("");
  let selectedItem = $state<PairedCoreEntry | null>(null);
  let reloadKey = $state(0);

  // Cores have no sync getById, so the detail works off the snapshot. The rename
  // draft is field-level (so the header can reflect it live) and re-inits when a
  // different core is opened. Reads selectedItem only, so typing won't reset it.
  let draftName = $state("");
  let savedName = $state("");
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const sel = selectedItem;
    draftName = sel?.name ?? "";
    savedName = sel?.name ?? "";
  });

  function isCurrent(id: string): boolean {
    return cores().currentEntry()?.id === id;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const id = selectedItem?.id;
    const name = draftName.trim();
    if (!id || !name || name === savedName) return;
    try {
      await cores().rename(id, name);
      savedName = name;
    } catch (e) {
      confirmState.alert({ title: "Rename failed", message: errMessage(e) });
    }
  }

  async function doSwitch(c: PairedCoreEntry) {
    try {
      await cores().select(c.id);
    } catch (e) {
      confirmState.alert({ title: "Switch failed", message: errMessage(e) });
    }
  }

  function doUnpair(c: PairedCoreEntry, after?: () => void) {
    confirmState.request({
      title: "Unpair core",
      message: `Unpair "${c.name}"? You will need to pair again to reconnect.`,
      destructive: true,
      confirmLabel: "Unpair",
      onConfirm: async () => {
        await cores().removePaired(c.id);
        // Mirror CoreManagement: lock back to setup if none remain, else make
        // sure some core is active again when the removed one was current.
        const remaining = await cores().list();
        if (remaining.length === 0) viewState.setLocked(true);
        else if (!cores().currentEntry()) await cores().select(remaining[0].id);
        after?.();
      },
    });
  }

  function cardMenuRows(c: PairedCoreEntry): MenuRow[] {
    const rows: MenuRow[] = [];
    if (!isCurrent(c.id)) {
      rows.push({ id: "switch", label: "Switch to This Core", onSelect: () => void doSwitch(c) });
    }
    rows.push({ id: "unpair", label: "Unpair", onSelect: () => doUnpair(c) });
    return rows;
  }

  function detailActions(c: PairedCoreEntry, close: () => void) {
    const actions = [];
    if (!isCurrent(c.id)) {
      actions.push({
        label: "Switch",
        icon: "i-material-symbols-swap-horiz-rounded",
        onSelect: () => void doSwitch(c),
      });
    }
    actions.push({
      label: "Unpair",
      icon: "i-material-symbols-link-off-rounded",
      variant: "danger" as const,
      onSelect: () => doUnpair(c, close),
    });
    return actions;
  }

  async function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const all = await cores().list();
    const text = q.text.toLowerCase();
    let items = all.filter(
      (c) => !text || c.name.toLowerCase().includes(text) || c.baseUrl.toLowerCase().includes(text),
    );
    if (q.sort === "name") items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    return { items, done: true };
  }
</script>

<ObjectManager
  {load}
  idOf={(c) => c.id}
  searchPlaceholder="Search paired cores"
  subscribe={(onChange) => cores().subscribe(onChange)}
  bind:query
  bind:selectedItem
  bind:reloadKey
  hasFilterSort
  onFilterSort={() =>
    showFilterSortMenu({
      filters: [],
      sorts: [{ value: "name", label: "Name" }],
      query,
      onQueryChange: (q) => (query = q),
    })}
  hasMenu
  onMenu={() =>
    showObjectActionMenu([
      { id: "pair", label: "Pair New Core", onSelect: () => viewState.navigate("coreManagement") },
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.name}
      description={item.baseUrl}
      badges={isCurrent(item.id) ? [{ label: "Current", accent: "green" }] : []}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item, close)}
    <ObjectDetailHeader
      title={draftName.trim() || item.name}
      badges={isCurrent(item.id) ? [{ label: "Current", accent: "green" }] : []}
      actions={detailActions(item, close)}
    />
    <div class="tomat-scroll flex-1 min-h-0 overflow-y-auto">
      <div class="flex flex-col gap-3">
        <FormField label="Name">
          <Input
            type="text"
            value={draftName}
            ariaLabel="Core name"
            oninput={(v) => {
              draftName = v;
              scheduleSave();
            }}
            onblur={() => flushSave()}
          />
        </FormField>
        <FormField label="Address">
          <div class="text-sm text-default-700 font-mono break-all">{item.baseUrl}</div>
        </FormField>
      </div>
    </div>
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.trim()}
        <div class="text-base text-default-700">No matching cores</div>
      {:else}
        <div class="text-base text-default-700">No paired cores</div>
        <div class="text-sm text-default-500">Use the menu to pair a new core.</div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
