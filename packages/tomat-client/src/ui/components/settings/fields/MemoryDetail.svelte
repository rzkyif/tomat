<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { type MemoryMeta, USER_MEMORY_PROVIDER } from "@tomat/shared";
  import { memoriesState } from "$stores";
  import { getLogger } from "$lib/util/log";
  import FormField from "@tomat/shared/ui/components/primitives/FormField.svelte";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import Textarea from "@tomat/shared/ui/components/primitives/Textarea.svelte";
  import Toggle from "@tomat/shared/ui/components/primitives/Toggle.svelte";

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

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

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

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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
  }

  async function toggleEnabled(enabled: boolean) {
    try {
      await memoriesState.setEnabled(item.id, enabled);
      reload();
    } catch (e) {
      log.error("Failed to toggle memory:", e);
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800">Enabled</span>
      <span class="text-xs text-default-600">
        {isSkill ? "Skill" : "Knowledge"}{editable ? "" : " · provided by an extension (read-only)"}
      </span>
    </div>
    <Toggle
      compact
      labels={{ on: "ON", off: "OFF" }}
      checked={item.enabled}
      ariaLabel="Enable memory"
      onchange={(v) => toggleEnabled(v)}
    />
  </div>

  <FormField label="Title" error={editable ? titleError : null}>
    <Input
      type="text"
      value={draftTitle}
      ariaLabel="Memory title"
      disabled={!editable}
      error={editable ? !!titleError : false}
      oninput={(v) => {
        draftTitle = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label={isSkill ? "Instructions (SKILL.md)" : "Content"}>
    <Textarea
      ariaLabel="Memory content"
      autoResize="none"
      class="min-h-48 overflow-y-auto resize-y font-mono"
      value={draftContent}
      placeholder={contentLoaded ? "" : "Loading..."}
      disabled={!contentLoaded || !editable}
      oninput={(v) => {
        draftContent = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  {#if isSkill && suggestedTools.length > 0}
    <div class="text-xs text-default-600">
      Suggested tools: <span class="font-mono">{suggestedTools.join(", ")}</span>
    </div>
  {/if}

  {#if isSkill && files.length > 0}
    <div class="flex flex-col gap-1">
      <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
        Bundled files
      </div>
      {#each files as f (f)}
        <code class="text-xs text-default-700">{f}</code>
      {/each}
    </div>
  {/if}
</div>
