<script lang="ts">
  import type { ScheduledPromptDraft } from "@tomat/shared";
  import ScheduleEditor from "../ScheduleEditor.svelte";
  import Input from "../../ui/Input.svelte";
  import Textarea from "../../ui/Textarea.svelte";
  import Toggle from "../../ui/Toggle.svelte";

  let {
    draft,
    onChange,
  }: {
    draft: ScheduledPromptDraft;
    onChange: (next: ScheduledPromptDraft) => void;
  } = $props();
</script>

<div class="flex flex-col gap-2 min-w-0 w-120 max-w-[calc(100vw-135px)] text-sm">
  <div class="flex items-center gap-2 text-default-800 font-medium">
    <i class="flex i-material-symbols-calendar-clock-outline-rounded text-amber-500 text-base shrink-0"></i>
    <span class="break-words">
      Review this Scheduled Prompt before it is saved. It runs as a new session at the
      scheduled times.
    </span>
  </div>
  <Input
    value={draft.title}
    oninput={(v) => onChange({ ...draft, title: v })}
    placeholder="Title"
    ariaLabel="Scheduled prompt title"
  />
  <Textarea
    value={draft.instruction}
    oninput={(v) => onChange({ ...draft, instruction: v })}
    autoResize="scroll"
    minHeight="min-h-16"
    placeholder="The prompt to send when it runs"
    ariaLabel="Scheduled prompt instruction"
  />
  <ScheduleEditor
    schedule={draft.schedule}
    onchange={(s) => onChange({ ...draft, schedule: s })}
  />
  <label class="flex items-center gap-2 text-xs text-default-700">
    <Toggle
      variant="pill"
      checked={draft.runMissed}
      onchange={(v) => onChange({ ...draft, runMissed: v })}
      ariaLabel="Make up a missed run"
    />
    Make up a missed run on the next start
  </label>
</div>
