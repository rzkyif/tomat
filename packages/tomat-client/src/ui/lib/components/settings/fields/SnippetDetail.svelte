<script lang="ts">
  import { untrack } from "svelte";
  import {
    normalizeTrigger,
    SNIPPET_PLACEMENT_OPTIONS,
    type Snippet,
    type SnippetPlacement,
    validateTrigger,
  } from "$lib/shared/snippets";
  import { snippetsState } from "$lib/state";
  import { getLogger } from "$lib/shared/log";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Input from "$lib/components/ui/Input.svelte";
  import Select from "$lib/components/ui/Select.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";

  const log = getLogger("snippets");

  // `reload` refreshes the list behind the detail so the card reflects edits.
  let { item, reload }: { item: Snippet; reload: () => void } = $props();

  // One-time snapshot of the opened snippet; later store updates must not clobber
  // an in-progress edit, so these are intentionally not derived from `item`.
  let draftName = $state(untrack(() => item.name));
  let draftTrigger = $state(untrack(() => item.trigger));
  let draftPlacement = $state<SnippetPlacement>(untrack(() => item.placement));
  let draftText = $state(untrack(() => item.text));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const otherTriggers = $derived(
    snippetsState.snippets.filter((s) => s.id !== item.id).map((s) => s.trigger.toLowerCase()),
  );
  const triggerError = $derived(validateTrigger(draftTrigger, otherTriggers));

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (triggerError) return;
    try {
      await snippetsState.save({
        id: item.id,
        name: draftName.trim() || "Untitled snippet",
        trigger: draftTrigger,
        placement: draftPlacement,
        text: draftText,
      });
      reload();
    } catch (e) {
      log.error("Failed to save snippet:", e);
    }
  }
</script>

<div class="flex flex-col gap-3">
  <FormField label="Name">
    <Input
      type="text"
      value={draftName}
      ariaLabel="Snippet name"
      oninput={(v) => {
        draftName = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Trigger" error={triggerError}>
    <Input
      type="text"
      value={draftTrigger.startsWith("@") ? draftTrigger.slice(1) : draftTrigger}
      placeholder="scientist"
      ariaLabel="Snippet trigger"
      mono
      error={!!triggerError}
      oninput={(v) => {
        draftTrigger = normalizeTrigger(v);
        scheduleSave();
      }}
      onblur={() => flushSave()}
    >
      {#snippet prefix()}<span class="font-mono">@</span>{/snippet}
    </Input>
  </FormField>

  <FormField label="Placement">
    <Select
      value={draftPlacement}
      options={SNIPPET_PLACEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      ariaLabel="Snippet placement"
      onchange={(v) => {
        draftPlacement = v as SnippetPlacement;
        scheduleSave();
      }}
    />
  </FormField>

  <FormField label="Text">
    <Textarea
      ariaLabel="Snippet text"
      autoResize="none"
      class="max-h-64 min-h-24 overflow-y-auto resize-none"
      value={draftText}
      oninput={(v) => {
        draftText = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>
</div>
