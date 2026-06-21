<script lang="ts">
  import { onMount } from "svelte";
  import type { MemoryMeta } from "@tomat/shared";
  import { confirmState, memoriesState } from "$stores";
  import { memoryTrigger } from "$stores/memories.svelte";
  import type { ParsedQuery } from "$lib/objects/query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/objects/menu";
  import { getLogger } from "$lib/util/log";
  import ObjectManager from "$components/ui/ObjectManager.svelte";
  import ObjectCard from "$components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "@tomat/shared/ui/components/objects/ObjectDetailHeader.svelte";
  import ObjectDetailScroll from "@tomat/shared/ui/components/objects/ObjectDetailScroll.svelte";
  import MemoryDetail from "./MemoryDetail.svelte";

  const log = getLogger("memories");

  let query = $state("");
  let selectedItem = $state<MemoryMeta | null>(null);
  let reloadKey = $state(0);

  onMount(() => void memoriesState.load().catch((e) => log.warn("memory load failed:", e)));

  function makeUniqueTitle(): string {
    const existing = new Set(memoriesState.memories.map((d) => d.title.toLowerCase()));
    let i = 1;
    while (existing.has(`new memory ${i}`)) i++;
    return `New memory ${i}`;
  }

  function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const text = q.text.toLowerCase();
    let list = memoriesState.memories.filter(
      (d) =>
        !text ||
        d.title.toLowerCase().includes(text) ||
        memoryTrigger(d).toLowerCase().includes(text),
    );
    if (q.sort === "title") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (q.sort === "updated") list = [...list].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return Promise.resolve({ items: list, done: true });
  }

  function cardMenuRows(d: MemoryMeta): MenuRow[] {
    return [
      {
        id: "delete",
        label: "Delete",
        onSelect: () =>
          confirmState.request({
            title: "Delete memory",
            message: `Delete memory "${d.title}"? This cannot be undone.`,
            destructive: true,
            confirmLabel: "Delete",
            onConfirm: async () => {
              await memoriesState.delete(d.id);
              reloadKey++;
            },
          }),
      },
    ];
  }

  async function newMemory() {
    const created = await memoriesState.create(makeUniqueTitle());
    reloadKey++;
    selectedItem = created;
  }
</script>

<ObjectManager
  {load}
  idOf={(d) => d.id}
  getById={(id) => memoriesState.memories.find((d) => d.id === id)}
  searchPlaceholder="Search memories"
  bind:query
  bind:selectedItem
  bind:reloadKey
  hasFilterSort
  onFilterSort={() =>
    showFilterSortMenu({
      filters: [],
      sorts: [
        { value: "title", label: "Title" },
        { value: "updated", label: "Last updated" },
      ],
      query,
      onQueryChange: (q) => (query = q),
    })}
  hasMenu
  onMenu={() =>
    showObjectActionMenu([
      { id: "new", label: "New Memory", onSelect: () => void newMemory() },
      {
        id: "rescan",
        label: "Rescan Memories",
        onSelect: async () => {
          // Re-read the memories directory on the core so files copied in
          // by hand show up without a restart.
          await memoriesState.rescan();
          reloadKey++;
        },
      },
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.title}
      description={item.summary || undefined}
      meta={memoryTrigger(item)}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item)}
    <ObjectDetailHeader title={item.title} subtitle={memoryTrigger(item)} />
    <ObjectDetailScroll>
      <MemoryDetail {item} reload={() => reloadKey++} />
    </ObjectDetailScroll>
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.trim()}
        <div class="text-base text-default-700">No matching memories</div>
      {:else}
        <div class="text-base text-default-700">No memories yet</div>
        <div class="text-sm text-default-500">
          Use the menu to create a memory, then reference it with @name in chat.
        </div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
