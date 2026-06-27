<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { type MemoryMeta, USER_MEMORY_PROVIDER } from "@tomat/shared";
  import { memoriesState } from "$stores";
  import { getLogger } from "$lib/util/log";
  import { createDebouncedSave } from "$lib/util/debounced-save";
  import MemoryDetailView from "@tomat/shared/ui/components/settings/MemoryDetailView.svelte";

  const log = getLogger("memories");

  // `reload` refreshes the list behind the detail so the card reflects edits.
  let { item, reload }: { item: MemoryMeta; reload: () => void } = $props();

  // Extension-provided memories are read-only; only the enable toggle applies.
  const editable = $derived(item.provider === USER_MEMORY_PROVIDER);
  const isSkill = $derived(item.kind === "skill");

  let draftTitle = $state(untrack(() => item.title));
  let draftContent = $state("");
  let contentLoaded = $state(false);
  let files = $state<string[]>([]);
  let suggestedTools = $state<string[]>([]);

  const otherTitles = $derived(
    memoriesState.memories
      .filter((d) => d.id !== item.id)
      .map((d) => d.title.toLowerCase()),
  );
  const titleError = $derived.by(() => {
    if (!draftTitle.trim()) return "Title cannot be empty";
    if (otherTitles.includes(draftTitle.trim().toLowerCase())) {
      return "A memory with this title already exists";
    }
    return null;
  });

  onMount(async () => {
    try {
      const doc = await memoriesState.get(item.id);
      draftContent = doc.content;
      files = doc.files ?? [];
      suggestedTools = doc.suggestedTools ?? [];
      contentLoaded = true;
    } catch (e) {
      log.error("Failed to load memory content:", e);
    }
  });

  const { scheduleSave, flushSave } = createDebouncedSave(async () => {
    if (!editable || titleError || !contentLoaded) return;
    try {
      await memoriesState.update(item.id, {
        title: draftTitle.trim(),
        content: draftContent,
      });
      reload();
    } catch (e) {
      log.error("Failed to save memory:", e);
    }
  });

  async function toggleEnabled(enabled: boolean) {
    try {
      await memoriesState.setEnabled(item.id, enabled);
      reload();
    } catch (e) {
      log.error("Failed to toggle memory:", e);
    }
  }
</script>

<MemoryDetailView
  enabled={item.enabled}
  {isSkill}
  {editable}
  {draftTitle}
  titleError={editable ? titleError : null}
  {contentLoaded}
  {suggestedTools}
  {files}
  bind:draftContent
  onToggleEnabled={(v) => toggleEnabled(v)}
  onTitleInput={(v) => {
    draftTitle = v;
    scheduleSave();
  }}
  onTitleBlur={() => flushSave()}
  onContentInput={(v) => {
    draftContent = v;
    scheduleSave();
  }}
  onContentBlur={() => flushSave()}
/>
