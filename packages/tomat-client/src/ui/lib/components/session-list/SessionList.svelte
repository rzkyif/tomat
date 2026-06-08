<script lang="ts">
  // Session list mode: a scrollable list of clickable session bubbles, each
  // showing the session title and a first-message summary. Replaces the
  // prev/next session navigation. When more than one core is paired, a core
  // switcher at the top changes which core's sessions are shown (it commits
  // the active core via cores().select()).

  import { onMount } from "svelte";
  import Bubble from "../ui/Bubble.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Select from "../ui/Select.svelte";
  import { sessionsState, settingsState, viewState } from "$lib/state";
  import { cores, type PairedCoreEntry } from "$lib/core";
  import { getLogger } from "$lib/shared/log";

  const log = getLogger("sessions");

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

  // Switching the core in the list commits the active core. It is the same
  // "active core" the Settings picker switches. The core-change subscription
  // in +layout reloads the session list for the newly-selected core.
  async function switchCore(): Promise<void> {
    confirmingDelete = null;
    if (!currentCoreId || currentCoreId === cores().currentEntry()?.id) return;
    try {
      await cores().select(currentCoreId);
    } catch (e) {
      log.warn("switch core failed:", e);
    }
  }

  function sessionTitle(title: string): string {
    return title.trim() || "Untitled session";
  }
</script>

<!-- A scrollable column of floating bubbles on the transparent window
     background: a header bubble, then one bubble per session, using the same
     bubble look as chat messages, not a card. -->
<div
  class="tomat-scroll flex flex-col gap-2 max-h-[80vh] overflow-y-auto min-h-0 -mr-1 pr-1"
>
  <!-- Header bubble -->
  <Bubble
    selectedAlignment={alignment}
    size="small"
    extraClass="flex items-center gap-2"
  >
    <IconButton
      icon="i-material-symbols-arrow-back-rounded"
      title="Back to Chat"
      size="md"
      variant="subtle"
      onclick={() => viewState.navigate("chat")}
    />
    <h1 class="text-sm font-medium text-default-800 flex-1">Sessions</h1>
    {#if pairedCores.length > 1}
      <div class="shrink-0">
        <Select
          value={currentCoreId}
          options={pairedCores.map((c) => ({ value: c.id, label: c.name }))}
          onchange={(v) => {
            currentCoreId = v;
            void switchCore();
          }}
          title="Core"
          class="w-auto"
        />
      </div>
    {/if}
    <IconButton
      icon="i-material-symbols-add-rounded"
      title="New Session"
      size="md"
      variant="subtle"
      onclick={newSession}
    />
  </Bubble>

  <!-- Session bubbles -->
  {#if sessionsState.list.length === 0}
    <Bubble
      selectedAlignment={alignment}
      size="small"
      extraClass="text-sm text-default-500"
    >
      No sessions yet. Start one with the + button above.
    </Bubble>
  {:else}
    {#each sessionsState.list as entry (entry.id)}
      <Bubble
        selectedAlignment={alignment}
        size="small"
        active={entry.id === sessionsState.id}
        borderColorClass="border-default-400"
        onclick={() => openSession(entry.id)}
        extraClass="flex items-center gap-3 cursor-pointer w-[28rem] max-w-full"
      >
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-sm text-default-800 truncate">
            {sessionTitle(entry.title)}
          </span>
          <span class="text-xs text-default-500 truncate">
            {entry.summary || "No messages yet"}
          </span>
        </div>
        <IconButton
          icon={confirmingDelete === entry.id
            ? "i-material-symbols-delete-forever-rounded"
            : "i-material-symbols-delete-outline-rounded"}
          title={confirmingDelete === entry.id
            ? "Confirm delete"
            : "Delete session"}
          size="md"
          variant="subtle"
          onclick={(e) => {
            e.stopPropagation();
            void deleteSession(entry.id);
          }}
          class={confirmingDelete === entry.id ? "text-accent-red-700" : ""}
        />
      </Bubble>
    {/each}
  {/if}
</div>
