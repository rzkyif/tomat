<script lang="ts">
  import { untrack } from "svelte";
  import {
    normalizeName,
    recommendedSymbol,
    SNIPPET_PLACEMENT_OPTIONS,
    SNIPPET_SYMBOLS,
    type Snippet,
    type SnippetPlacement,
    type SnippetSymbol,
    snippetTrigger,
    validateName,
  } from "$lib/snippets/snippets";
  import { snippetsState } from "$stores";
  import { getLogger } from "$lib/util/log";
  import FormField from "@tomat/shared/ui/components/primitives/FormField.svelte";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import Select from "@tomat/shared/ui/components/primitives/Select.svelte";
  import Textarea from "@tomat/shared/ui/components/primitives/Textarea.svelte";

  const log = getLogger("snippets");

  // `reload` refreshes the list behind the detail so the card reflects edits.
  let { item, reload }: { item: Snippet; reload: () => void } = $props();

  // One-time snapshot of the opened snippet; later store updates must not clobber
  // an in-progress edit, so these are intentionally not derived from `item`.
  let draftName = $state(untrack(() => item.name));
  let draftSymbol = $state<SnippetSymbol>(untrack(() => item.symbol));
  let draftPlacement = $state<SnippetPlacement>(untrack(() => item.placement));
  let draftText = $state(untrack(() => item.text));
  // Once the user picks a symbol themselves (persisted as `symbolPinned`), stop
  // auto-tracking the recommendation on later placement changes. Reading the
  // stored flag (not re-inferring from the symbol) so a deliberate choice that
  // happens to equal the recommendation is still respected.
  let symbolTouched = $state(untrack(() => item.symbolPinned));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const otherTriggers = $derived(
    snippetsState.snippets
      .filter((s) => s.id !== item.id)
      .map((s) => snippetTrigger(s).toLowerCase()),
  );
  const nameError = $derived(validateName(draftSymbol, draftName, otherTriggers));
  const recommended = $derived(recommendedSymbol(draftPlacement));
  const symbolOptions = $derived(
    SNIPPET_SYMBOLS.map((sym) => ({
      value: sym,
      label: sym === recommended ? `${sym}  (Recommended)` : sym,
    })),
  );

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (nameError) return;
    try {
      await snippetsState.save({
        id: item.id,
        name: draftName,
        symbol: draftSymbol,
        symbolPinned: symbolTouched,
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
      placeholder="scientist"
      ariaLabel="Snippet name"
      mono
      error={!!nameError}
      oninput={(v) => {
        draftName = normalizeName(v);
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Trigger" error={nameError}>
    <Select
      value={draftSymbol}
      options={symbolOptions}
      ariaLabel="Snippet trigger symbol"
      onchange={(v) => {
        draftSymbol = v as SnippetSymbol;
        symbolTouched = true;
        scheduleSave();
      }}
    />
    <p class="mt-1 text-xs text-muted font-mono">{draftSymbol}{draftName || "name"}</p>
  </FormField>

  <FormField label="Placement">
    <Select
      value={draftPlacement}
      options={SNIPPET_PLACEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      ariaLabel="Snippet placement"
      onchange={(v) => {
        draftPlacement = v as SnippetPlacement;
        if (!symbolTouched) draftSymbol = recommendedSymbol(draftPlacement);
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
