<script lang="ts">
  import type { Snippet } from "svelte";
  import Bubble from "../../primitives/Bubble.svelte";
  import { useUiContext } from "../../../context.ts";

  // Presentational user message: a `bubble-user` Bubble holding the message text
  // (or an edit field) plus any attachments. Behaviour (editing, context menu)
  // stays in the client wrapper and arrives via props/snippets; the website
  // feeds static text. Alignment comes from the UI context so both apps match.
  const ui = useUiContext();

  let {
    text,
    editable = false,
    active = false,
    ondblclick,
    oncontextmenu,
    editBody,
    attachmentRow,
  }: {
    text: string;
    /** True while this message is being edited (renders `editBody`). */
    editable?: boolean;
    /** Thickened/pulsing active border (the client uses it while editing). */
    active?: boolean;
    ondblclick?: (e: MouseEvent) => void;
    oncontextmenu?: (e: MouseEvent) => void;
    /** The edit textarea, supplied by the client while `editable`. */
    editBody?: Snippet;
    /** Attachment row, supplied by the caller (client `AttachmentList` with its
     *  lazy image loading; website `AttachmentListView`). */
    attachmentRow?: Snippet;
  } = $props();
</script>

<Bubble
  selectedAlignment={ui.getAlignment()}
  bgClass="bubble-user"
  extraClass="flex flex-col gap-4"
  {active}
  {ondblclick}
  {oncontextmenu}
>
  {#if editable && editBody}
    {@render editBody()}
  {:else}
    <span class="whitespace-pre-wrap break-words">{text}</span>
  {/if}
  {@render attachmentRow?.()}
</Bubble>
