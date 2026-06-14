<script lang="ts">
  // Bubble for `role: "display"` messages: content a tool pushed into the
  // chat via ctx.display.* or show_document. Same small expandable shell as
  // SystemMessage, but expanded by default (the tool explicitly asked to
  // show this).
  import { untrack } from "svelte";
  import type { DisplayContent } from "@tomat/shared";
  import Bubble from "../../ui/Bubble.svelte";
  import Expandable from "../../ui/Expandable.svelte";
  import MessageMarkdown from "./MessageMarkdown.svelte";
  import DiffView from "../DiffView.svelte";
  import { settingsState } from "../../../state";
  import { expansionState } from "$lib/state/expansion.svelte";

  let {
    id,
    content,
    neighborLeft = false,
    neighborRight = false,
  }: {
    id?: string;
    content: DisplayContent;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  } = $props();

  const bubbleTitle = $derived.by(() => {
    switch (content.type) {
      case "markdown":
        return "Content";
      case "image":
        return content.alt || "Image";
      case "table":
        return "Table";
      case "diff":
        return content.title || "Changes";
    }
  });

  let expanded = $state(
    untrack(() => (id !== undefined ? (expansionState.get(id) ?? true) : true)),
  );
  // External/local expansion sync, exactly as in SystemMessage.svelte (see
  // the comments there); only the default differs.
  $effect(() => {
    if (id === undefined) return;
    const stored = expansionState.get(id) ?? true;
    untrack(() => {
      if (stored !== expanded) expanded = stored;
    });
  });
  $effect(() => {
    if (id === undefined) return;
    const local = expanded;
    untrack(() => {
      const current = expansionState.get(id) ?? true;
      if (current !== local) expansionState.set(id, local);
    });
  });
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  size="small"
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded alignment={settingsState.getAlignment()}>
    {#snippet title()}
      <span>{bubbleTitle}</span>
    {/snippet}
    {#snippet children()}
      <!-- `text-left` keeps the body alignment-independent (the Expandable
           wrapper applies `text-right` when the bubble is right-aligned). -->
      <div class="text-left">
        {#if content.type === "markdown"}
          <div class="bg-surface-inset text-default-800 text-sm px-4 py-2 rounded-large">
            <MessageMarkdown content={content.markdown} />
          </div>
        {:else if content.type === "image"}
          <img
            src={`data:${content.mime};base64,${content.dataB64}`}
            alt={content.alt ?? "Tool-provided image"}
            class="max-w-full rounded-large"
          />
        {:else if content.type === "table"}
          <div class="bg-surface-inset rounded-large px-2 py-2 overflow-x-auto">
            <table class="text-xs text-default-800 w-full">
              <thead>
                <tr>
                  {#each content.columns as col}
                    <th class="text-left font-semibold px-2 py-1">{col}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each content.rows as row}
                  <tr>
                    {#each row as cell}
                      <td class="px-2 py-1 align-top">{cell}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if content.type === "diff"}
          <DiffView before={content.before} after={content.after} />
        {/if}
      </div>
    {/snippet}
  </Expandable>
</Bubble>
