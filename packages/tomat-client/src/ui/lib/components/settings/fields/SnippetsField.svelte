<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import {
    normalizeTrigger,
    validateTrigger,
    SNIPPET_PLACEMENT_OPTIONS,
    type Snippet,
    type SnippetPlacement,
  } from "$lib/shared/snippets";
  import { snippetsState, confirmState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";
  import Button from "../../ui/Button.svelte";
  import IconButton from "../../ui/IconButton.svelte";
  import Input from "../../ui/Input.svelte";
  import Select from "../../ui/Select.svelte";
  import Textarea from "../../ui/Textarea.svelte";

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

</script>

<FieldCard {field}>
  <div class="flex items-center gap-2">
    {#if snippetsState.snippets.length > 0}
      <div class="flex-1">
        <Select
          value={selectedId ?? ""}
          options={[
            { value: "", label: "Select a snippet..." },
            ...snippetsState.snippets.map((s) => ({
              value: s.id,
              label: `${s.name || s.trigger} (${s.trigger})`,
            })),
          ]}
          onchange={(v) =>
            void flushSave().then(() => {
              selectedId = v || null;
            })}
          ariaLabel="Select snippet"
        />
      </div>
    {/if}
    <Button
      icon="i-material-symbols-add-rounded"
      onclick={handleAdd}
      title="Add snippet"
      class="shrink-0"
    >
      Add
    </Button>
    {#if selectedId}
      <IconButton
        icon="i-material-symbols-delete-outline-rounded"
        title="Delete snippet"
        size="lg"
        surface="filled"
        class="hover:bg-accent-red-500 hover:text-white"
        onclick={handleDelete}
      />
    {/if}
  </div>

  {#if selectedSnippet}
    <div class="flex flex-col gap-2 pt-1">
      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Name</div>
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
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Trigger</div>
        <Input
          type="text"
          value={draftTrigger.startsWith("@")
            ? draftTrigger.slice(1)
            : draftTrigger}
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
        {#if triggerError}
          <div class="text-red-500 text-sm">{triggerError}</div>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Placement</div>
        <Select
          value={draftPlacement}
          options={SNIPPET_PLACEMENT_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
          }))}
          ariaLabel="Snippet placement"
          onchange={(v) => {
            draftPlacement = v as SnippetPlacement;
            scheduleSave();
          }}
        />
      </div>

      <div class="flex flex-col gap-1">
        <div class="text-default-600 text-sm">Text</div>
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
      </div>
    </div>
  {/if}
</FieldCard>
