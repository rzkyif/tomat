<script lang="ts">
  import type { SettingField } from "$lib/shared/settings";
  import {
    normalizeTrigger,
    validateTrigger,
    SNIPPET_PLACEMENT_OPTIONS,
    type Snippet,
    type SnippetPlacement,
  } from "$lib/shared/snippets";
  import { snippetsState, confirmState } from "../../state";
  import FieldDescription from "./FieldDescription.svelte";

  let { field } = $props<{ field: SettingField }>();

  let selectedId = $state<string | null>(null);
  let draftName = $state("");
  let draftTrigger = $state("");
  let draftPlacement = $state<SnippetPlacement>("append-system");
  let draftText = $state("");

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  let selectedSnippet = $derived(
    snippetsState.snippets.find((s) => s.id === selectedId) || null,
  );

  let otherTriggers = $derived(
    snippetsState.snippets
      .filter((s) => s.id !== selectedId)
      .map((s) => s.trigger.toLowerCase()),
  );

  let triggerError = $derived.by(() => {
    if (!selectedId) return null;
    return validateTrigger(draftTrigger, otherTriggers);
  });

  // Sync drafts whenever a different snippet becomes selected (or the
  // underlying record changes due to reload).
  let lastSyncedId = $state<string | null>(null);
  $effect(() => {
    if (selectedId !== lastSyncedId) {
      lastSyncedId = selectedId;
      if (selectedSnippet) {
        draftName = selectedSnippet.name;
        draftTrigger = selectedSnippet.trigger;
        draftPlacement = selectedSnippet.placement;
        draftText = selectedSnippet.text;
      } else {
        draftName = "";
        draftTrigger = "";
        draftPlacement = "append-system";
        draftText = "";
      }
    }
  });

  function scheduleSave() {
    if (!selectedId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), 500);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!selectedId) return;
    if (triggerError) return;
    const next: Snippet = {
      id: selectedId,
      name: draftName.trim() || "Untitled snippet",
      trigger: draftTrigger,
      placement: draftPlacement,
      text: draftText,
    };
    try {
      await snippetsState.save(next);
    } catch (e) {
      console.error("Failed to save snippet:", e);
    }
  }

  function generateId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  }

  function makeUniqueTrigger(): string {
    const existing = new Set(
      snippetsState.snippets.map((s) => s.trigger.toLowerCase()),
    );
    let i = 1;
    while (existing.has(`@snippet${i}`)) i++;
    return `@snippet${i}`;
  }

  async function handleAdd() {
    await flushSave();
    const id = generateId();
    const snippet: Snippet = {
      id,
      name: "New snippet",
      trigger: makeUniqueTrigger(),
      placement: "append-system",
      text: "",
    };
    try {
      await snippetsState.save(snippet);
      selectedId = id;
    } catch (e) {
      console.error("Failed to create snippet:", e);
    }
  }

  function handleDelete() {
    if (!selectedId || !selectedSnippet) return;
    const id = selectedId;
    const label = selectedSnippet.name || selectedSnippet.trigger;
    confirmState.request({
      title: "Delete snippet",
      message: `Delete snippet "${label}"? This cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
      onConfirm: async () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        try {
          await snippetsState.delete(id);
          selectedId = null;
        } catch (e) {
          console.error("Failed to delete snippet:", e);
        }
      },
    });
  }

  function handleSelectChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    void flushSave().then(() => {
      selectedId = value || null;
    });
  }

  function handleTriggerInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    draftTrigger = normalizeTrigger(raw);
    scheduleSave();
  }
</script>

<div
  class="flex flex-col gap-2 px-4 pt-2 pb-3 bg-default-100 rounded-2xl border-2 border-transparent"
>
  <div class="flex flex-col">
    <div class="text-default-800">{field.name}</div>
    {#if field.description}
      <FieldDescription text={field.description} />
    {/if}
  </div>

  <div class="flex items-center gap-2">
    {#if snippetsState.snippets.length > 0}
      <div class="relative flex-1">
        <select
          aria-label="Select snippet"
          class="appearance-none bg-default-300 text-default-800 rounded-lg block w-full h-8 px-2 pr-7 outline-none"
          value={selectedId ?? ""}
          onchange={handleSelectChange}
        >
          <option value="">Select a snippet...</option>
          {#each snippetsState.snippets as snippet (snippet.id)}
            <option value={snippet.id}
              >{snippet.name || snippet.trigger} ({snippet.trigger})</option
            >
          {/each}
        </select>
        <i
          class="i-material-symbols-expand-more-rounded absolute right-1.5 top-1/2 -translate-y-1/2 text-default-600 pointer-events-none"
        ></i>
      </div>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1 shrink-0 bg-default-300 hover:bg-default-400 text-default-800 rounded-lg px-3 h-8 text-sm hover:cursor-pointer transition-colors"
      onclick={handleAdd}
      title="Add snippet"
    >
      <i class="flex i-material-symbols-add-rounded"></i>
      <span>Add</span>
    </button>
    {#if selectedId}
      <button
        type="button"
        class="flex items-center shrink-0 bg-default-300 hover:bg-err text-default-800 hover:text-white rounded-lg w-8 h-8 justify-center hover:cursor-pointer transition-colors"
        onclick={handleDelete}
        title="Delete snippet"
        aria-label="Delete snippet"
      >
        <i class="flex i-material-symbols-delete-outline-rounded"></i>
      </button>
    {/if}
  </div>

  {#if selectedSnippet}
    <div class="flex flex-col gap-2 pt-1">
      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Name</div>
        <input
          type="text"
          aria-label="Snippet name"
          class="bg-default-300 text-default-800 rounded-lg block w-full h-8 px-2 outline-none"
          value={draftName}
          oninput={(e) => {
            draftName = (e.target as HTMLInputElement).value;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        />
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Trigger</div>
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <span
              class="absolute left-2 top-1/2 -translate-y-1/2 text-default-500 pointer-events-none font-mono"
              >@</span
            >
            <input
              type="text"
              aria-label="Snippet trigger"
              class="bg-default-300 text-default-800 rounded-lg block w-full h-8 pl-6 pr-2 outline-none font-mono {triggerError
                ? 'bg-err-input border-err border'
                : ''}"
              value={draftTrigger.startsWith("@")
                ? draftTrigger.slice(1)
                : draftTrigger}
              oninput={handleTriggerInput}
              onblur={() => flushSave()}
              placeholder="scientist"
            />
          </div>
        </div>
        {#if triggerError}
          <div class="text-red-500 text-sm">{triggerError}</div>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Placement</div>
        <div class="relative">
          <select
            aria-label="Snippet placement"
            class="appearance-none bg-default-300 text-default-800 rounded-lg block w-full h-8 px-2 pr-7 outline-none"
            value={draftPlacement}
            onchange={(e) => {
              draftPlacement = (e.target as HTMLSelectElement)
                .value as SnippetPlacement;
              scheduleSave();
            }}
          >
            {#each SNIPPET_PLACEMENT_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
          <i
            class="i-material-symbols-expand-more-rounded absolute right-1.5 top-1/2 -translate-y-1/2 text-default-600 pointer-events-none"
          ></i>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Text</div>
        <textarea
          aria-label="Snippet text"
          class="bg-default-300 text-default-800 rounded-lg w-full px-2 py-1.5 outline-none resize-none max-h-64 min-h-24 overflow-y-auto whitespace-pre-wrap break-words text-sm"
          value={draftText}
          oninput={(e) => {
            draftText = (e.target as HTMLTextAreaElement).value;
            scheduleSave();
          }}
          onblur={() => flushSave()}
        ></textarea>
      </div>
    </div>
  {/if}
</div>
