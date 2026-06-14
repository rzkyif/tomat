<script lang="ts">
  import { onMount } from "svelte";
  import type { DocumentMeta } from "@tomat/shared";
  import { confirmState, documentsState } from "$lib/state";
  import { documentTrigger } from "$lib/state/documents.svelte";
  import type { ParsedQuery } from "$lib/shared/object-query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/shared/object-menu";
  import { getLogger } from "$lib/shared/log";
  import ObjectManager from "$lib/components/ui/ObjectManager.svelte";
  import ObjectCard from "$lib/components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "$lib/components/ui/ObjectDetailHeader.svelte";
  import ObjectDetailScroll from "$lib/components/ui/ObjectDetailScroll.svelte";
  import DocumentDetail from "./DocumentDetail.svelte";

  const log = getLogger("documents");

  let query = $state("");
  let selectedItem = $state<DocumentMeta | null>(null);
  let reloadKey = $state(0);

  onMount(() => void documentsState.load().catch((e) => log.warn("document load failed:", e)));

  function makeUniqueTitle(): string {
    const existing = new Set(documentsState.documents.map((d) => d.title.toLowerCase()));
    let i = 1;
    while (existing.has(`new document ${i}`)) i++;
    return `New document ${i}`;
  }

  function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const text = q.text.toLowerCase();
    let list = documentsState.documents.filter(
      (d) =>
        !text ||
        d.title.toLowerCase().includes(text) ||
        documentTrigger(d).toLowerCase().includes(text),
    );
    if (q.sort === "title") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (q.sort === "updated") list = [...list].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return Promise.resolve({ items: list, done: true });
  }

  function cardMenuRows(d: DocumentMeta): MenuRow[] {
    return [
      {
        id: "delete",
        label: "Delete",
        onSelect: () =>
          confirmState.request({
            title: "Delete document",
            message: `Delete document "${d.title}"? This cannot be undone.`,
            destructive: true,
            confirmLabel: "Delete",
            onConfirm: async () => {
              await documentsState.delete(d.id);
              reloadKey++;
            },
          }),
      },
    ];
  }

  async function newDocument() {
    const created = await documentsState.create(makeUniqueTitle());
    reloadKey++;
    selectedItem = created;
  }
</script>

<ObjectManager
  {load}
  idOf={(d) => d.id}
  getById={(id) => documentsState.documents.find((d) => d.id === id)}
  searchPlaceholder="Search documents"
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
      { id: "new", label: "New Document", onSelect: () => void newDocument() },
      {
        id: "rescan",
        label: "Rescan Documents",
        onSelect: async () => {
          // Re-read the documents directory on the core so files copied in
          // by hand show up without a restart.
          await documentsState.rescan();
          reloadKey++;
        },
      },
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.title}
      description={item.summary || undefined}
      meta={documentTrigger(item)}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item)}
    <ObjectDetailHeader title={item.title} subtitle={documentTrigger(item)} />
    <ObjectDetailScroll>
      <DocumentDetail {item} reload={() => reloadKey++} />
    </ObjectDetailScroll>
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.trim()}
        <div class="text-base text-default-700">No matching documents</div>
      {:else}
        <div class="text-base text-default-700">No documents yet</div>
        <div class="text-sm text-default-500">
          Use the menu to create a document, then reference it with @name in chat.
        </div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
