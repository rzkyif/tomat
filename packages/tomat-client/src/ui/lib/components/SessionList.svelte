<script lang="ts">
  // Session list mode: a scrollable list of clickable session bubbles, each
  // showing the session title and a first-message summary. Replaces the
  // prev/next session navigation. When more than one core is paired, a core
  // switcher at the top changes which core's sessions are shown (it commits
  // the active core via cores().select()).

  import { onMount } from "svelte";
  import Bubble from "./ui/Bubble.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import ListItem from "./ui/ListItem.svelte";
  import Select from "./ui/Select.svelte";
  import { sessionsState, settingsState, viewState } from "$lib/state";
  import { cores, type PairedCoreEntry } from "$lib/core";

  let alignment = $derived(settingsState.getAlignment());

  let pairedCores = $state<PairedCoreEntry[]>([]);
  let currentCoreId = $state<string>("");
  let confirmingDelete = $state<string | null>(null);

  async function refreshCores(): Promise<void> {
    try {
      pairedCores = await cores().list();
      currentCoreId = cores().currentEntry()?.id ?? "";
    } catch {
      /* */
    }
  }

  onMount(() => {
    void sessionsState.loadList();
    void refreshCores();
    const unsub = cores().subscribe(() => void refreshCores());
    return () => unsub();
  });

  async function openSession(id: string): Promise<void> {
    await sessionsState.load(id);
    viewState.navigate("chat");
  }

  async function newSession(): Promise<void> {
    await sessionsState.create();
    viewState.navigate("chat");
  }

  async function deleteSession(id: string): Promise<void> {
    if (confirmingDelete !== id) {
      confirmingDelete = id;
      return;
    }
    confirmingDelete = null;
    await sessionsState.deleteById(id);
  }

  // Switching the core in the list commits the active core — the same
  // "active core" the Settings picker switches. The core-change subscription
  // in +layout reloads the session list for the newly-selected core.
  async function switchCore(): Promise<void> {
    confirmingDelete = null;
    if (!currentCoreId || currentCoreId === cores().currentEntry()?.id) return;
    try {
      await cores().select(currentCoreId);
    } catch (e) {
      console.warn("[sessionList] switch core failed:", e);
    }
  }

  function sessionTitle(title: string): string {
    return title.trim() || "Untitled session";
  }
</script>

<Bubble
  selectedAlignment={alignment}
  extraClass="flex flex-col gap-3 w-[32rem] max-w-full"
>
  <!-- Header -->
  <div class="flex items-center gap-2">
    <IconButton
      icon="i-material-symbols-arrow-back-rounded"
      title="Back to Chat"
      size="lg"
      variant="subtle"
      surface="circle"
      onclick={() => viewState.navigate("chat")}
    />
    <h1 class="text-lg font-medium text-default-800 flex-1">Sessions</h1>
    {#if pairedCores.length > 1}
      <div class="shrink-0">
        <Select
          value={currentCoreId}
          options={pairedCores.map((c) => ({ value: c.id, label: c.name }))}
          onchange={(v) => {
            currentCoreId = v;
            void switchCore();
          }}
          surface="subtle"
          title="Core"
          class="w-auto"
        />
      </div>
    {/if}
    <IconButton
      icon="i-material-symbols-add-rounded"
      title="New Session"
      size="lg"
      variant="subtle"
      surface="circle"
      onclick={newSession}
    />
  </div>

  <!-- Session bubbles -->
  <div class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto min-h-0 -mr-1 pr-1">
    {#if sessionsState.list.length === 0}
      <div class="text-sm text-default-500 px-3 py-8 text-center">
        No sessions yet. Start one with the + button above.
      </div>
    {:else}
      {#each sessionsState.list as entry (entry.id)}
        <ListItem
          selected={entry.id === sessionsState.id}
          onclick={() => openSession(entry.id)}
        >
          <span class="text-sm text-default-800 truncate">
            {sessionTitle(entry.title)}
          </span>
          <span class="text-xs text-default-500 truncate">
            {entry.summary || "No messages yet"}
          </span>
          {#snippet trailing()}
            <IconButton
              icon={confirmingDelete === entry.id
                ? "i-material-symbols-delete-forever-rounded"
                : "i-material-symbols-delete-outline-rounded"}
              title={confirmingDelete === entry.id
                ? "Confirm delete"
                : "Delete session"}
              size="md"
              variant="subtle"
              onclick={() => deleteSession(entry.id)}
              class={confirmingDelete === entry.id ? "text-accent-red-700" : ""}
            />
          {/snippet}
        </ListItem>
      {/each}
    {/if}
  </div>
</Bubble>
