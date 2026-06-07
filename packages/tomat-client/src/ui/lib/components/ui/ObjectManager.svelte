<script lang="ts" generics="T">
  import { onMount, type Snippet, untrack } from "svelte";
  import { errMessage } from "@tomat/shared";
  import SearchInput from "./SearchInput.svelte";
  import IconButton from "./IconButton.svelte";
  import { type ParsedQuery, parseQuery } from "$lib/shared/object-query";

  // Generic, presentational shell for the object-management settings UI:
  // search bar + optional filter/sort + optional triple-dot, a batched
  // infinite-scroll list, and a list<->detail swap with Esc-to-back. It holds
  // ZERO domain logic; each per-type field supplies data (load/idOf/subscribe),
  // the toolbar menu handlers, and the card/detail/empty snippets.
  let {
    load,
    idOf,
    getById,
    searchPlaceholder,
    subscribe,
    query = $bindable(""),
    selectedItem = $bindable(null),
    reloadKey = $bindable(0),
    hasFilterSort = false,
    onFilterSort,
    hasMenu = false,
    onMenu,
    menuBusy = false,
    card,
    detail,
    empty,
  }: {
    load: (
      ctx: { offset: number; limit: number; query: ParsedQuery },
    ) => Promise<{ items: T[]; done: boolean }>;
    idOf: (item: T) => string;
    /** Live lookup for detail freshness; omit for async-only sources (cores).
     *  When present and it returns undefined, the detail auto-closes. */
    getById?: (id: string) => T | undefined;
    searchPlaceholder: string;
    /** Reactivity bridge (WS / store change) -> reload from offset 0. */
    subscribe?: (onChange: () => void) => () => void;
    query?: string;
    /** null = list mode; an item = detail mode. Bindable so a field can open a
     *  freshly-created item, and the shell can clear it on back/Esc. */
    selectedItem?: T | null;
    /** Bump to force a reload from offset 0 (after add/delete with no subscribe). */
    reloadKey?: number;
    hasFilterSort?: boolean;
    onFilterSort?: () => void;
    hasMenu?: boolean;
    onMenu?: () => void;
    /** When true the triple-dot swaps to a spinner + disables (e.g. while a
     *  field-level action like "Check for Updates" runs). */
    menuBusy?: boolean;
    card: Snippet<[T, () => void]>;
    detail: Snippet<[T, () => void]>;
    empty: Snippet;
  } = $props();

  const PAGE = 30;

  let items = $state<T[]>([]);
  let done = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let sentinelEl = $state<HTMLElement>();
  let scrollEl = $state<HTMLElement>();

  // Discards stale async loads (the query changed or a reset happened while a
  // fetch was in flight).
  let loadSeq = 0;

  // The fresh selected item (from the store when getById is available) or the
  // snapshot captured on card click.
  const live = $derived(
    selectedItem === null ? null : getById ? getById(idOf(selectedItem)) : selectedItem,
  );
  // The selected item vanished (deleted/unpaired elsewhere): return to the list.
  $effect(() => {
    if (selectedItem !== null && getById && live === undefined) selectedItem = null;
  });

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    const seq = ++loadSeq;
    try {
      const res = await load({ offset: items.length, limit: PAGE, query: parseQuery(query) });
      if (seq !== loadSeq) return; // superseded by a newer load/reset
      items = items.concat(res.items);
      done = res.done;
      error = null;
    } catch (e) {
      if (seq === loadSeq) error = errMessage(e);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function reset() {
    loadSeq++; // invalidate any in-flight load
    items = [];
    done = false;
    loading = false;
    error = null;
    void loadMore();
  }

  // Reload on query (debounced) or reloadKey (immediate). Plain locals are
  // intentionally non-reactive so only query / reloadKey are effect deps.
  let started = false;
  let lastQuery = untrack(() => query);
  let lastReloadKey = untrack(() => reloadKey);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const q = query;
    const rk = reloadKey;
    if (!started) {
      started = true;
      lastQuery = q;
      lastReloadKey = rk;
      reset();
      return;
    }
    if (rk !== lastReloadKey) {
      lastReloadKey = rk;
      lastQuery = q;
      reset();
      return;
    }
    if (q !== lastQuery) {
      lastQuery = q;
      // Editing the query (typing, clearing, or inserting a filter/sort token)
      // exits detail back to the list. Field-level actions (the triple-dot)
      // don't touch the query, so they leave the detail open.
      selectedItem = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reset, 200);
    }
  });

  // Esc returns from detail to list (mirrors Modal/Popover). Active only in
  // detail mode; stops propagation so it never closes the Settings panel.
  $effect(() => {
    if (selectedItem === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        selectedItem = null;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  onMount(() => {
    const unsub = subscribe?.(() => reset());
    let observer: IntersectionObserver | undefined;
    if (sentinelEl && scrollEl) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) void loadMore();
        },
        { root: scrollEl, rootMargin: "200px" },
      );
      observer.observe(sentinelEl);
    }
    return () => {
      unsub?.();
      observer?.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  const emptyVisible = $derived(items.length === 0 && !loading && !error);
</script>

<div class="h-full flex flex-col gap-2">
  <!-- Toolbar stays visible in both list and detail mode. Editing the search
       (or inserting a filter/sort token) exits detail; the triple-dot does not. -->
  <div class="flex items-center gap-1 shrink-0">
    <div class="flex-1 min-w-0">
      <SearchInput bind:value={query} placeholder={searchPlaceholder} onclear={() => (query = "")} />
    </div>
    {#if hasFilterSort}
      <IconButton
        icon="i-material-symbols-filter-alt"
        title="Filter and sort"
        size="lg"
        surface="filled"
        rounded="rounded-large"
        onclick={() => onFilterSort?.()}
      />
    {/if}
    {#if hasMenu}
      <IconButton
        icon={menuBusy
          ? "i-material-symbols-progress-activity animate-spin"
          : "i-material-symbols-more-vert"}
        title="More actions"
        size="lg"
        surface="filled"
        rounded="rounded-large"
        disabled={menuBusy}
        onclick={() => onMenu?.()}
      />
    {/if}
  </div>

  <!-- Only this area swaps between list and detail. The list stays mounted but
       hidden under detail so its scroll / query / loaded pages survive. -->
  <div class="flex-1 min-h-0 flex flex-col">
    <div
      bind:this={scrollEl}
      class="tomat-scroll flex-1 min-h-0 overflow-y-auto pr-2 {selectedItem !== null ? 'hidden' : ''}"
    >
      {#if error}
        <div class="px-3 py-2 text-sm text-accent-red-600">{error}</div>
      {/if}
      {#if emptyVisible}
        {@render empty()}
      {:else}
        <div class="flex flex-col">
          {#each items as item (idOf(item))}
            {@render card(item, () => (selectedItem = item))}
          {/each}
        </div>
      {/if}
      <div bind:this={sentinelEl} class="h-px"></div>
      {#if loading}
        <div class="flex justify-center py-3 text-default-500">
          <i class="i-material-symbols-progress-activity animate-spin text-lg"></i>
        </div>
      {/if}
    </div>

    {#if selectedItem !== null && live !== undefined && live !== null}
      <!-- Back button is a left gutter spanning the detail, so the title (in
           ObjectDetailHeader) and the form body below share one left edge. -->
      <div class="flex-1 min-h-0 flex gap-2">
        <IconButton
          icon="i-material-symbols-arrow-back-rounded"
          title="Back to list"
          size="md"
          surface="none"
          onclick={() => (selectedItem = null)}
          class="self-start shrink-0"
        />
        <div class="flex flex-col gap-3 flex-1 min-w-0 min-h-0">
          {@render detail(live, () => (selectedItem = null))}
        </div>
      </div>
    {/if}
  </div>
</div>
