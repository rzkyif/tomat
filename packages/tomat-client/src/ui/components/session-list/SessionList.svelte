<script lang="ts">
  // Session list mode: a scrollable list of clickable session bubbles, each
  // showing the session title and a conversation summary. Replaces the
  // prev/next session navigation. Which core's sessions are shown follows the
  // connected core; switching cores lives in the CoreBar pinned below.

  import { onMount } from "svelte";
  import type { SessionListEntry, SummaryPart } from "@tomat/shared";
  import Bubble from "@tomat/shared/ui/components/primitives/Bubble.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";
  import { bubbleGap, useUiContext } from "@tomat/shared/ui/context";
  import { sessionsState, settingsState, viewState } from "$stores";
  import { formatSessionDefaultTitle } from "$lib/util/format";
  import { platform } from "$lib/platform";

  const ui = useUiContext();
  let alignment = $derived(settingsState.getAlignment());
  // On mobile the list fills the screen width (the page wrapper's slim p-3 is the
  // only horizontal padding), so the bubbles go full-width instead of the
  // desktop's fixed 28rem column; the back row is dropped where the OS owns back.
  const mobile = $derived(ui.platform === "mobile");

  let confirmingDelete = $state<string | null>(null);

  onMount(() => {
    void sessionsState.loadList();
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

  // Touch long-press opens an action sheet (the sheet IS the confirmation, so it
  // deletes directly rather than going through the two-tap icon-button confirm).
  // touch-only via the Bubble's longpress action, so desktop is unaffected.
  async function openSessionMenu(id: string): Promise<void> {
    const chosen = await platform().menu.showContextMenu([
      { id: "open", label: "Open" },
      { id: "delete", label: "Delete Session" },
    ]);
    if (chosen === "open") await openSession(id);
    else if (chosen === "delete") await sessionsState.deleteById(id);
  }

  // Untitled sessions fall back to their creation datetime, matching the
  // session bar's placeholder, so no session ever reads as "Untitled".
  function sessionTitle(entry: SessionListEntry): string {
    return entry.title.trim() || formatSessionDefaultTitle(entry.createdAtMs);
  }

  // Labels are rendered client-side so the configured agent name applies.
  let agentLabel = $derived(
    ((settingsState.currentSettings["general.context.agentName"] as string) ?? "").trim() ||
      "Agent",
  );

  function summaryText(parts: SummaryPart[]): string {
    return parts
      .map((p) => `${p.role === "user" ? "User" : agentLabel}: "${p.text}"`)
      .join(" ");
  }
</script>

<!-- A column of floating bubbles on the transparent window background: a
     header bubble, then one bubble per session, using the same bubble look
     as chat messages, not a card. No scroll container of its own: the page's
     chat scroll area owns scrolling, exactly like the chat view. -->
<div class="flex flex-col" style:gap={bubbleGap(ui)}>
  <!-- Header bubble -->
  <Bubble
    selectedAlignment={alignment}
    size="small"
    fullWidth={mobile}
    extraClass="flex items-center gap-2 {mobile ? '' : 'w-[28rem] max-w-full'}"
  >
    {#if !ui.hasSystemBack}
      <!-- -ml-1 cancels the IconButton's own p-1 inset so the arrow glyph
           left-aligns with the session bubbles' title/summary text. Dropped on
           Android, where the system back returns to chat. -->
      <IconButton
        icon="i-material-symbols-arrow-back-rounded"
        title="Back to Chat"
        size="md"
        variant="subtle"
        class="-ml-1"
        onclick={() => viewState.navigate("chat")}
      />
    {/if}
    <h1 class="text-sm font-medium text-default-800 flex-1">Sessions</h1>
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
      fullWidth={mobile}
      extraClass="text-sm text-default-500"
    >
      No sessions yet. Start one with the + button above.
    </Bubble>
  {:else}
    {#each sessionsState.list as entry (entry.id)}
      {@const isCurrent = entry.id === sessionsState.id}
      <!-- The current session carries the screen-edge `active` border. The
           border paints outside the content div this width class sizes, so
           shave the border's 8px off the content to keep every bubble's
           total width identical (center alignment borders the bottom edge,
           which doesn't affect width). -->
      <Bubble
        selectedAlignment={alignment}
        size="small"
        active={isCurrent}
        fullWidth={mobile}
        borderColorClass={isCurrent ? "border-default-400" : ""}
        onclick={() => openSession(entry.id)}
        onlongpress={() => void openSessionMenu(entry.id)}
        extraClass="flex items-center gap-3 cursor-pointer {mobile
          ? ''
          : (isCurrent && alignment !== 'center' ? 'w-[calc(28rem-8px)]' : 'w-[28rem]') + ' max-w-full'}"
      >
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-sm text-default-800 truncate">
            {sessionTitle(entry)}
          </span>
          <span class="text-xs text-default-500 truncate">
            {entry.summary.length > 0 ? summaryText(entry.summary) : "No messages yet"}
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
