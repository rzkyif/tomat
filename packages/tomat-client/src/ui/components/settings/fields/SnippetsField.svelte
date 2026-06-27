<script lang="ts">
  import { onMount } from "svelte";
  import { confirmState, snippetsState } from "$stores";
  import {
    recommendedSymbol,
    SNIPPET_PLACEMENT_OPTIONS,
    type Snippet,
    snippetTrigger,
  } from "$lib/snippets/snippets";
  import type { ParsedQuery } from "$lib/objects/query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/objects/menu";
  import ObjectManager from "$components/ui/ObjectManager.svelte";
  import ObjectCard from "$components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "@tomat/shared/ui/components/objects/ObjectDetailHeaderView.svelte";
  import ObjectDetailScroll from "@tomat/shared/ui/components/objects/ObjectDetailScrollView.svelte";
  import SnippetDetail from "./SnippetDetail.svelte";

  let query = $state("");
  let selectedItem = $state<Snippet | null>(null);
  let reloadKey = $state(0);

  onMount(() => void snippetsState.load());

  function placementLabel(p: Snippet["placement"]): string {
    return SNIPPET_PLACEMENT_OPTIONS.find((o) => o.value === p)?.label ?? p;
  }

  function makeUniqueName(): string {
    const existing = new Set(snippetsState.snippets.map((s) => s.name.toLowerCase()));
    let i = 1;
    while (existing.has(`snippet${i}`)) i++;
    return `snippet${i}`;
  }

  function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const text = q.text.toLowerCase();
    let list = snippetsState.snippets.filter(
      (s) =>
        !text ||
        s.name.toLowerCase().includes(text) ||
        snippetTrigger(s).toLowerCase().includes(text),
    );
    if (q.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (q.sort === "trigger") {
      list = [...list].sort((a, b) => snippetTrigger(a).localeCompare(snippetTrigger(b)));
    }
    return Promise.resolve({ items: list, done: true });
  }

  function cardMenuRows(s: Snippet): MenuRow[] {
    return [
      {
        id: "delete",
        label: "Delete",
        onSelect: () =>
          confirmState.request({
            title: "Delete snippet",
            message: `Delete snippet "${s.name || snippetTrigger(s)}"? This cannot be undone.`,
            destructive: true,
            confirmLabel: "Delete",
            onConfirm: async () => {
              await snippetsState.delete(s.id);
              reloadKey++;
            },
          }),
      },
    ];
  }

  async function newSnippet() {
    const created = await snippetsState.create({
      name: makeUniqueName(),
      symbol: recommendedSymbol("append-system"),
      symbolPinned: false,
      placement: "append-system",
      text: "",
    });
    reloadKey++;
    selectedItem = created;
  }
</script>

<ObjectManager
  {load}
  idOf={(s) => s.id}
  getById={(id) => snippetsState.snippets.find((s) => s.id === id)}
  searchPlaceholder="Search snippets"
  bind:query
  bind:selectedItem
  bind:reloadKey
  hasFilterSort
  onFilterSort={() =>
    showFilterSortMenu({
      filters: [],
      sorts: [
        { value: "name", label: "Name" },
        { value: "trigger", label: "Trigger" },
      ],
      query,
      onQueryChange: (q) => (query = q),
    })}
  hasMenu
  onMenu={() =>
    showObjectActionMenu([
      { id: "new", label: "New Snippet", onSelect: () => void newSnippet() },
      {
        id: "rescan",
        label: "Rescan Snippets",
        onSelect: async () => {
          // Re-read the snippets directory so files copied in by hand show
          // up without a restart.
          await snippetsState.load();
          reloadKey++;
        },
      },
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.name || "Untitled snippet"}
      description={item.text || undefined}
      meta={snippetTrigger(item)}
      badges={[{ label: placementLabel(item.placement) }]}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item)}
    <ObjectDetailHeader title={item.name || "Untitled snippet"} subtitle={snippetTrigger(item)} />
    <ObjectDetailScroll>
      <SnippetDetail {item} reload={() => reloadKey++} />
    </ObjectDetailScroll>
  {/snippet}
  {#snippet empty()}
    <div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
      {#if query.trim()}
        <div class="text-base text-default-700">No matching snippets</div>
      {:else}
        <div class="text-base text-default-700">No snippets yet</div>
        <div class="text-sm text-default-500">
          Use the menu to create a snippet, then trigger it with #, @, or / in chat.
        </div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
