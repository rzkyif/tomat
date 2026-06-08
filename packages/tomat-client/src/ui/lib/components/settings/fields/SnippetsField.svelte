<script lang="ts">
  import { onMount } from "svelte";
  import { confirmState, snippetsState } from "$lib/state";
  import { SNIPPET_PLACEMENT_OPTIONS, type Snippet } from "$lib/shared/snippets";
  import type { ParsedQuery } from "$lib/shared/object-query";
  import { type MenuRow, showFilterSortMenu, showObjectActionMenu } from "$lib/shared/object-menu";
  import ObjectManager from "$lib/components/ui/ObjectManager.svelte";
  import ObjectCard from "$lib/components/ui/ObjectCard.svelte";
  import ObjectDetailHeader from "$lib/components/ui/ObjectDetailHeader.svelte";
  import ObjectDetailScroll from "$lib/components/ui/ObjectDetailScroll.svelte";
  import SnippetDetail from "./SnippetDetail.svelte";

  let query = $state("");
  let selectedItem = $state<Snippet | null>(null);
  let reloadKey = $state(0);

  onMount(() => void snippetsState.load());

  function placementLabel(p: Snippet["placement"]): string {
    return SNIPPET_PLACEMENT_OPTIONS.find((o) => o.value === p)?.label ?? p;
  }

  function generateId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  }

  function makeUniqueTrigger(): string {
    const existing = new Set(snippetsState.snippets.map((s) => s.trigger.toLowerCase()));
    let i = 1;
    while (existing.has(`@snippet${i}`)) i++;
    return `@snippet${i}`;
  }

  function load({ query: q }: { offset: number; limit: number; query: ParsedQuery }) {
    const text = q.text.toLowerCase();
    let list = snippetsState.snippets.filter(
      (s) => !text || s.name.toLowerCase().includes(text) || s.trigger.toLowerCase().includes(text),
    );
    if (q.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (q.sort === "trigger") list = [...list].sort((a, b) => a.trigger.localeCompare(b.trigger));
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
            message: `Delete snippet "${s.name || s.trigger}"? This cannot be undone.`,
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
    const id = generateId();
    await snippetsState.save({
      id,
      name: "New snippet",
      trigger: makeUniqueTrigger(),
      placement: "append-system",
      text: "",
    });
    reloadKey++;
    const created = snippetsState.snippets.find((s) => s.id === id);
    if (created) selectedItem = created;
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
    ])}
>
  {#snippet card(item, open)}
    <ObjectCard
      label={item.name || "Untitled snippet"}
      description={item.text || undefined}
      meta={item.trigger}
      badges={[{ label: placementLabel(item.placement) }]}
      menuRows={cardMenuRows(item)}
      onOpen={open}
    />
  {/snippet}
  {#snippet detail(item)}
    <ObjectDetailHeader title={item.name || "Untitled snippet"} subtitle={item.trigger} />
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
          Use the menu to create a snippet, then trigger it with @name in chat.
        </div>
      {/if}
    </div>
  {/snippet}
</ObjectManager>
