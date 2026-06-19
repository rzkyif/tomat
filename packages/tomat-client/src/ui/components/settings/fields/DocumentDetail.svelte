<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { DocumentMeta } from "@tomat/shared";
  import { documentsState } from "$stores";
  import { getLogger } from "$lib/util/log";
  import FormField from "@tomat/shared/ui/components/primitives/FormField.svelte";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import Textarea from "@tomat/shared/ui/components/primitives/Textarea.svelte";

  const log = getLogger("documents");

  // `reload` refreshes the list behind the detail so the card reflects edits.
  let { item, reload }: { item: DocumentMeta; reload: () => void } = $props();

  // One-time snapshot of the opened document; later store updates must not
  // clobber an in-progress edit, so these are intentionally not derived.
  let draftTitle = $state(untrack(() => item.title));
  // Content lives on the core only (the list carries metadata), so the editor
  // starts disabled until the fetch lands.
  let draftContent = $state("");
  let contentLoaded = $state(false);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const otherTitles = $derived(
    documentsState.documents
      .filter((d) => d.id !== item.id)
      .map((d) => d.title.toLowerCase()),
  );
  const titleError = $derived.by(() => {
    if (!draftTitle.trim()) return "Title cannot be empty";
    if (otherTitles.includes(draftTitle.trim().toLowerCase())) {
      return "A document with this title already exists";
    }
    return null;
  });

  onMount(async () => {
    try {
      const doc = await documentsState.get(item.id);
      draftContent = doc.content;
      contentLoaded = true;
    } catch (e) {
      log.error("Failed to load document content:", e);
    }
  });

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (titleError || !contentLoaded) return;
    try {
      await documentsState.update(item.id, {
        title: draftTitle.trim(),
        content: draftContent,
      });
      reload();
    } catch (e) {
      log.error("Failed to save document:", e);
    }
  }
</script>

<div class="flex flex-col gap-3">
  <FormField label="Title" error={titleError}>
    <Input
      type="text"
      value={draftTitle}
      ariaLabel="Document title"
      error={!!titleError}
      oninput={(v) => {
        draftTitle = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Content">
    <Textarea
      ariaLabel="Document content"
      autoResize="none"
      class="min-h-48 overflow-y-auto resize-y font-mono"
      value={draftContent}
      placeholder={contentLoaded ? "" : "Loading..."}
      disabled={!contentLoaded}
      oninput={(v) => {
        draftContent = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>
</div>
