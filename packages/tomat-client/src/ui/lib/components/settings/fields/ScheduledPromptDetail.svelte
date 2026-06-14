<script lang="ts">
  import { untrack } from "svelte";
  import type { ScheduledPrompt, ScheduleSpec } from "@tomat/shared";
  import { scheduledPromptsState } from "$lib/state";
  import { lastRunText, nextRunText } from "$lib/state/scheduled-prompts.svelte";
  import { getLogger } from "$lib/shared/log";
  import ScheduleEditor from "$lib/components/chat/ScheduleEditor.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Input from "$lib/components/ui/Input.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";
  import Toggle from "$lib/components/ui/Toggle.svelte";

  const log = getLogger("scheduled-prompts");

  // `reload` refreshes the list behind the detail so the card reflects edits.
  let { item, reload }: { item: ScheduledPrompt; reload: () => void } = $props();

  // One-time snapshot of the opened schedule; later store updates must not
  // clobber an in-progress edit, so these are intentionally not derived.
  let draftTitle = $state(untrack(() => item.title));
  let draftInstruction = $state(untrack(() => item.instruction));
  let draftSchedule = $state<ScheduleSpec>(untrack(() => structuredClone(item.schedule)));
  let draftRunMissed = $state(untrack(() => item.runMissed));
  let draftEnabled = $state(untrack(() => item.enabled));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Run bookkeeping (next/last run) updates server-side on every save, so
  // read it from the live store row rather than the opening snapshot.
  const live = $derived(scheduledPromptsState.prompts.find((p) => p.id === item.id) ?? item);

  const titleError = $derived(draftTitle.trim() ? null : "Title cannot be empty");
  const instructionError = $derived(
    draftInstruction.trim() ? null : "Prompt cannot be empty",
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
    if (titleError || instructionError) return;
    try {
      await scheduledPromptsState.update(item.id, {
        title: draftTitle.trim(),
        instruction: draftInstruction,
        schedule: $state.snapshot(draftSchedule),
        runMissed: draftRunMissed,
        enabled: draftEnabled,
      });
      reload();
    } catch (e) {
      log.error("Failed to save scheduled prompt:", e);
    }
  }

  async function runNow() {
    await flushSave();
    try {
      await scheduledPromptsState.run(item.id);
      reload();
    } catch (e) {
      log.error("Failed to run scheduled prompt:", e);
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between gap-2">
    <div class="flex flex-col text-xs text-default-600">
      <span>{nextRunText(live)}</span>
      {#if lastRunText(live)}
        <span>{lastRunText(live)}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <Button size="sm" onclick={() => void runNow()}>Run Now</Button>
      <Toggle
        variant="pill"
        checked={draftEnabled}
        ariaLabel="Enable schedule"
        onchange={(v) => {
          draftEnabled = v;
          void flushSave();
        }}
      />
    </div>
  </div>

  <FormField label="Title" error={titleError}>
    <Input
      type="text"
      value={draftTitle}
      ariaLabel="Scheduled prompt title"
      error={!!titleError}
      oninput={(v) => {
        draftTitle = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Prompt" error={instructionError}>
    <Textarea
      ariaLabel="Scheduled prompt instruction"
      autoResize="none"
      class="max-h-60 min-h-24 overflow-y-auto resize-none"
      value={draftInstruction}
      error={!!instructionError}
      oninput={(v) => {
        draftInstruction = v;
        scheduleSave();
      }}
      onblur={() => flushSave()}
    />
  </FormField>

  <FormField label="Schedule">
    <ScheduleEditor
      schedule={draftSchedule}
      onchange={(s) => {
        draftSchedule = s;
        scheduleSave();
      }}
    />
  </FormField>

  <label class="flex items-center gap-2 text-sm text-default-700">
    <Toggle
      variant="pill"
      checked={draftRunMissed}
      ariaLabel="Make up a missed run"
      onchange={(v) => {
        draftRunMissed = v;
        void flushSave();
      }}
    />
    Make up a missed run on the next start
  </label>
</div>
