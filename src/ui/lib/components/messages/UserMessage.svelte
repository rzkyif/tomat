<script lang="ts">
  import { onDestroy } from "svelte";
  import AttachmentList from "../AttachmentList.svelte";
  import Bubble from "../Bubble.svelte";
  import { settingsState } from "../../state";
  import {
    getTextContent,
    type MessageContent,
    type MessagePart,
  } from "$lib/shared/types";
  import { showUserMessageMenu } from "$lib/shared/messageMenu";

  let {
    content,
    isLast = false,
    onEdit,
    onDelete,
  } = $props<{
    content: MessageContent;
    isLast?: boolean;
    onEdit?: (newContent: MessageContent) => void;
    onDelete?: () => void;
  }>();

  let editText = $state("");
  let editTimeout: ReturnType<typeof setTimeout> | null = null;

  onDestroy(() => {
    if (editTimeout) {
      clearTimeout(editTimeout);
      editTimeout = null;
    }
  });

  let displayText = $derived(getTextContent(content));

  // Extract document and image parts for display
  let attachments = $derived(
    typeof content === "string"
      ? []
      : (content as MessagePart[]).filter(
          (p) =>
            p.type === "document" ||
            p.type === "image_url" ||
            p.type === "document_file" ||
            p.type === "image_file",
        ),
  );

  // Local copy of attachments for editing (so removals are tracked)
  let editAttachments = $state<MessagePart[]>([]);

  // Edit toggle: auto-enabled on the most recent user message, auto-reset when
  // a new turn pushes this one out of the "last" slot. User can override via
  // the edit button on any message.
  let editing = $state(false);
  $effect.pre(() => {
    editing = isLast;
  });

  // Sync editText and editAttachments with content when entering edit mode
  $effect(() => {
    if (editing) {
      editText = displayText;
      editAttachments = [...attachments];
    }
  });

  /** Build updated MessageContent from current edit state */
  function buildEditContent(): MessageContent {
    const trimmed = editText.trim();
    if (editAttachments.length === 0) {
      return trimmed;
    }
    const parts: MessagePart[] = [];
    if (trimmed) {
      parts.push({ type: "text", text: trimmed });
    }
    parts.push(...editAttachments);
    return parts;
  }

  function emitEdit() {
    if (!onEdit) return;
    const newContent = buildEditContent();
    const isEmpty =
      typeof newContent === "string" ? !newContent : newContent.length === 0;
    if (isEmpty) {
      onEdit(newContent);
      return;
    }
    const oldText = displayText;
    const newText = editText.trim();
    const attachmentsChanged = editAttachments.length !== attachments.length;
    if (newText !== oldText || attachmentsChanged) {
      onEdit(newContent);
    }
  }

  function handleEditInput() {
    if (editTimeout) clearTimeout(editTimeout);
    editTimeout = setTimeout(() => emitEdit(), 1000);
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      editText = displayText;
      editAttachments = [...attachments];
      if (editTimeout) clearTimeout(editTimeout);
    }
  }

  function removeAttachment(index: number) {
    editAttachments = editAttachments.filter((_, i) => i !== index);
    if (editTimeout) clearTimeout(editTimeout);
    setTimeout(() => emitEdit(), 0);
  }

  function toggleEdit() {
    // Flush pending debounce before toggling off so typed changes aren't lost.
    if (editing && editTimeout) {
      clearTimeout(editTimeout);
      editTimeout = null;
      emitEdit();
    }
    editing = !editing;
  }
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  bgClass="bubble-user"
  extraClass={"flex flex-col gap-4"}
  active={editing}
  oncontextmenu={(e) => {
    e.preventDefault();
    void showUserMessageMenu({
      editing,
      onToggleEdit: onEdit ? toggleEdit : undefined,
      onDelete,
    });
  }}
>
  {#if editing}
    <div class="grid w-fit min-w-0 max-w-[calc(100vw-135px)] overflow-clip">
      <span
        class="invisible whitespace-pre-wrap break-words wrap-break-word col-start-1 row-start-1 pointer-events-none"
        >{editText + "\u200b"}</span
      >
      <textarea
        bind:value={editText}
        oninput={handleEditInput}
        onkeydown={handleEditKeydown}
        class="col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words"
        rows="1"
        cols="1"
      ></textarea>
    </div>
  {:else}
    <span class="whitespace-pre-wrap break-words">{displayText}</span>
  {/if}

  <AttachmentList
    parts={editing ? editAttachments : attachments}
    editable={editing}
    onRemove={removeAttachment}
  />
</Bubble>
