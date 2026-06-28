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
  const summarized = $derived(!!item.summary);
  // Absent flag (older cores) is treated as stale so the status never claims a
  // summary is current when we can't tell.
  const summaryStale = $derived(item.summaryStale ?? true);

  let draftTitle = $state(untrack(() => item.title));
  let draftContent = $state("");
  let contentLoaded = $state(false);
  let files = $state<string[]>([]);
  let suggestedTools = $state<string[]>([]);
  let reindexing = $state(false);

  // The currently open bundled file, loaded on demand.
  let openFileName = $state<string | null>(null);
  let openFileContent = $state("");
  let openFileLoaded = $state(false);

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

  const fileSave = createDebouncedSave(async () => {
    if (!editable || !openFileName || !openFileLoaded) return;
    try {
      await memoriesState.writeFile(item.id, openFileName, openFileContent);
      reload();
    } catch (e) {
      log.error("Failed to save bundled file:", e);
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

  async function reindex() {
    reindexing = true;
    try {
      await memoriesState.reindex(item.id);
      reload();
    } catch (e) {
      log.error("Failed to reindex memory:", e);
    } finally {
      reindexing = false;
    }
  }

  async function openFile(name: string) {
    fileSave.flushSave();
    openFileName = name;
    openFileLoaded = false;
    openFileContent = "";
    try {
      const content = await memoriesState.getFile(item.id, name);
      // A second click (or a close) may have superseded this load while the
      // fetch was in flight; don't drop another file's content into the editor.
      if (openFileName !== name) return;
      openFileContent = content;
      openFileLoaded = true;
    } catch (e) {
      log.error("Failed to load bundled file:", e);
    }
  }

  function closeFile() {
    fileSave.flushSave();
    openFileName = null;
    openFileContent = "";
    openFileLoaded = false;
  }

  async function addFile(name: string) {
    if (files.includes(name)) {
      await openFile(name);
      return;
    }
    try {
      await memoriesState.writeFile(item.id, name, "");
      files = [...files, name].sort();
      reload();
      await openFile(name);
    } catch (e) {
      log.error("Failed to add bundled file:", e);
    }
  }

  async function deleteFile(name: string) {
    try {
      await memoriesState.deleteFile(item.id, name);
      files = files.filter((f) => f !== name);
      if (openFileName === name) closeFile();
      reload();
    } catch (e) {
      log.error("Failed to delete bundled file:", e);
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
  {summarized}
  {summaryStale}
  {reindexing}
  {suggestedTools}
  {files}
  bind:draftContent
  {openFileName}
  bind:openFileContent
  {openFileLoaded}
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
  onReindex={() => reindex()}
  onOpenFile={(name) => openFile(name)}
  onCloseFile={() => closeFile()}
  onFileContentInput={(v) => {
    openFileContent = v;
    fileSave.scheduleSave();
  }}
  onFileContentBlur={() => fileSave.flushSave()}
  onAddFile={(name) => addFile(name)}
  onDeleteFile={(name) => deleteFile(name)}
/>
