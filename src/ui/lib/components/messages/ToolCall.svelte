<script lang="ts">
  import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolCallState,
  } from "$lib/shared/types";
  import Bubble from "../Bubble.svelte";
  import Expandable from "../Expandable.svelte";
  import { settingsState } from "../../state";
  import { expansionState } from "$lib/state/expansion.svelte";
  import { untrack } from "svelte";

  let {
    id,
    toolCall,
    onAnswer,
    neighborLeft = false,
    neighborRight = false,
  } = $props<{
    id?: string;
    toolCall: ToolCallState;
    onAnswer: (requestId: string, answers: AskUserAnswer[]) => void;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  }>();

  // Expansion state: shared with MessageStackGroup so the stack can react
  // (force expanded mode while any bubble is open). Read once via untrack so
  // the initial seed doesn't flip mid-render.
  let expanded = $state(
    untrack(() =>
      id !== undefined ? (expansionState.get(id) ?? false) : false,
    ),
  );
  // Bidirectional sync with expansionState. Cross-side reads are wrapped in
  // `untrack` so each effect only fires on its own side's changes. Without
  // that, the external→local effect would also re-run on local toggles and
  // race against the local→external effect, with the side that runs first
  // (declaration order = external→local) reverting the user's click.
  $effect(() => {
    if (id === undefined) return;
    const stored = expansionState.get(id) ?? false;
    untrack(() => {
      if (stored !== expanded) expanded = stored;
    });
  });
  $effect(() => {
    if (id === undefined) return;
    const local = expanded;
    untrack(() => {
      const current = expansionState.get(id) ?? false;
      if (current !== local) expansionState.set(id, local);
    });
  });
  // Auto-open when the tool enters `awaiting_user` so the user can answer,
  // and auto-close once the tool reaches a terminal state (complete /
  // failed / cancelled), but ONLY if it actually went through awaiting_user
  // earlier. `wasAwaiting` flips on entry and is cleared on the terminal
  // transition; this prevents non-interactive tool calls (e.g. a tool that
  // ran straight to "complete" without ever asking the user) from being
  // forcibly collapsed against a manual expansion the user might have made.
  let wasAwaiting = $state(false);
  $effect(() => {
    const status = toolCall.status;
    if (status === "awaiting_user") {
      expanded = true;
      wasAwaiting = true;
    } else if (
      wasAwaiting &&
      (status === "complete" ||
        status === "failed" ||
        status === "cancelled")
    ) {
      expanded = false;
      wasAwaiting = false;
    }
  });

  // Working copy of in-flight askUser answers. Indexed by question number.
  // `picks` holds option values; `freestyleActive` means the freeform text is
  // the current selection (mutually exclusive with picks). Having both state
  // bits lets the freeform input look "inactive" after clicking an option
  // even while its text value is preserved for reference.
  type DraftAnswer = {
    text: string;
    picks: string[];
    freestyleActive: boolean;
  };
  let drafts: Record<number, DraftAnswer> = $state({});
  let lastSeenRequestId: string | null = $state(null);

  function ensureDrafts(questions: AskUserQuestion[], requestId: string) {
    if (lastSeenRequestId === requestId) return;
    const next: Record<number, DraftAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      next[i] = { text: "", picks: [], freestyleActive: false };
    }
    drafts = next;
    lastSeenRequestId = requestId;
  }

  $effect(() => {
    if (toolCall.askUser && toolCall.status === "awaiting_user") {
      ensureDrafts(toolCall.askUser.questions, toolCall.askUser.requestId);
    }
  });

  function blankDraft(): DraftAnswer {
    return { text: "", picks: [], freestyleActive: false };
  }

  function togglePick(idx: number, value: string, multi: boolean) {
    const d = drafts[idx] ?? blankDraft();
    // Clicking an option always wins over freestyle: picks become the
    // selection, freeform is marked inactive (but text is kept so the user
    // can see what they typed and come back to it).
    if (multi) {
      const set = new Set(d.picks);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      drafts[idx] = { ...d, picks: Array.from(set), freestyleActive: false };
    } else {
      drafts[idx] = { ...d, picks: [value], freestyleActive: false };
    }
  }

  function setText(idx: number, text: string) {
    const d = drafts[idx] ?? blankDraft();
    // Non-empty text promotes freestyle to the active selection and clears
    // option picks; emptying the text demotes it back to inactive.
    const active = text.trim().length > 0;
    drafts[idx] = {
      ...d,
      text,
      picks: active ? [] : d.picks,
      freestyleActive: active,
    };
  }

  function focusFreestyle(idx: number) {
    const d = drafts[idx] ?? blankDraft();
    if (d.text.trim().length === 0) return;
    if (d.freestyleActive && d.picks.length === 0) return;
    drafts[idx] = { ...d, picks: [], freestyleActive: true };
  }

  function readyToSubmit(questions: AskUserQuestion[]): boolean {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const d = drafts[i] ?? blankDraft();
      if (!q.options) {
        if (!d.text.trim()) return false;
        continue;
      }
      const hasFreestyle =
        !!q.allowFreeformInput && d.freestyleActive && !!d.text.trim();
      if (q.multiselect) {
        if (d.picks.length === 0 && !hasFreestyle) return false;
        continue;
      }
      if (d.picks.length === 0 && !hasFreestyle) return false;
    }
    return true;
  }

  function submit() {
    if (!toolCall.askUser) return;
    const qs = toolCall.askUser.questions;
    const answers: AskUserAnswer[] = [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const d = drafts[i] ?? blankDraft();
      if (!q.options) {
        answers.push(d.text.trim());
        continue;
      }
      const useFreestyle =
        !!q.allowFreeformInput && d.freestyleActive && !!d.text.trim();
      if (q.multiselect) {
        answers.push(useFreestyle ? [d.text.trim()] : [...d.picks]);
      } else {
        answers.push(useFreestyle ? d.text.trim() : (d.picks[0] ?? ""));
      }
    }
    onAnswer(toolCall.askUser.requestId, answers);
  }

  // Wrapper text around the tool name, keyed by status. The name renders as
  // inline code in the middle; when `toolCall.label` is set the whole sentence
  // is replaced by that label (label is a freeform override from the tool).
  let statusPhrase = $derived.by(() => {
    const configured = (
      (settingsState.currentSettings["general.context.agentName"] as string) ||
      ""
    ).trim();
    const agent = configured || "Agent";
    switch (toolCall.status) {
      case "awaiting_user":
        return { pre: `${agent} awaiting input for `, post: " tool:" };
      case "complete":
        return { pre: `${agent} used `, post: " tool." };
      case "failed":
        return { pre: `${agent} failed to use `, post: " tool." };
      case "cancelled":
        return { pre: `${agent} cancelled `, post: " tool." };
      case "pending":
      case "running":
      default:
        return { pre: `${agent} is using `, post: " tool." };
    }
  });

  let statusColor = $derived.by(() => {
    switch (toolCall.status) {
      case "awaiting_user":
        return "text-amber-500";
      case "failed":
        return "text-accent-red-500";
      default:
        return "text-default-800";
    }
  });

  // Determinate percent when the tool reports `progress` (0..1). When the
  // call is active (pending/running) but no number has been reported yet, we
  // render an indeterminate bar instead.
  let percent = $derived(
    typeof toolCall.progress === "number"
      ? Math.round(toolCall.progress * 100)
      : null,
  );
  let isActive = $derived(
    toolCall.status === "pending" || toolCall.status === "running",
  );
  let showProgress = $derived(isActive);

  let resultText = $derived.by(() => {
    if (toolCall.result === undefined) return "";
    try {
      return JSON.stringify(toolCall.result, null, 2);
    } catch {
      return String(toolCall.result);
    }
  });

  let argsText = $derived.by(() => {
    try {
      return JSON.stringify(toolCall.arguments ?? {}, null, 2);
    } catch {
      return "";
    }
  });

  let hasArgs = $derived(
    !!toolCall.arguments && Object.keys(toolCall.arguments).length > 0,
  );
  let hasLogs = $derived(toolCall.logs.length > 0);
  let hasResult = $derived(
    toolCall.status === "complete" && toolCall.result !== undefined,
  );
  let hasError = $derived(toolCall.status === "failed" && !!toolCall.error);
  let hasCancelledError = $derived(
    toolCall.status === "cancelled" && !!toolCall.error,
  );
  let hasAskUser = $derived(
    toolCall.status === "awaiting_user" && !!toolCall.askUser,
  );
  let hasBody = $derived(
    !!toolCall.description ||
      hasArgs ||
      hasLogs ||
      hasResult ||
      hasError ||
      hasCancelledError ||
      hasAskUser,
  );

  // Side border, same mechanism as AgentMessage/UserMessage: Bubble renders
  // a chunky side border when `active` is true. Only light it up for states
  // that carry a color cue: failed (red) and awaiting input (amber). We
  // still pass a neutral `border-default-400` for the other states so the
  // browser has a stable border-color to interpolate from when the width
  // animates between 0 and 8px on status transitions; otherwise the color
  // pops in at the wrong instant and the growth looks choppy.
  let borderColorClass = $derived(
    toolCall.status === "failed"
      ? "border-accent-red-400"
      : toolCall.status === "awaiting_user"
        ? "border-amber-400"
        : "border-default-400",
  );
  let borderActive = $derived(
    toolCall.status === "failed" || toolCall.status === "awaiting_user",
  );
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  size="small"
  extraClass="text-default-800 min-w-60"
  active={borderActive}
  {borderColorClass}
  progress={showProgress ? percent : undefined}
  {neighborLeft}
  {neighborRight}
>
  <Expandable
    bind:expanded
    alignment={settingsState.getAlignment()}
    disabled={!hasBody}
  >
    {#snippet title()}
      <span class={statusColor}>
        {#if toolCall.label}
          {toolCall.label}
        {:else}
          {statusPhrase.pre}<code class="tc-inline">{toolCall.toolName}</code
          >{statusPhrase.post}
        {/if}
      </span>
      {#if toolCall.description && !expanded}
        <span class="text-default-600 truncate">{toolCall.description}</span>
      {/if}
    {/snippet}
    {#snippet children()}
      <!-- 14px = chevron icon (1em = 12px in text-xs) - 0.5 (2px negative
           margin) + gap-1 (4px). Padding goes on the side where the chevron
           sits so the body lines up with the label text in the header. -->
      <div
        class="flex flex-col gap-2"
        class:pl-3.5={settingsState.getAlignment() !== "right"}
        class:pr-3.5={settingsState.getAlignment() === "right"}
      >
        {#if toolCall.description}
          <div class="text-xs text-default-600">{toolCall.description}</div>
        {/if}

        {#if hasAskUser && toolCall.askUser}
          <div class="flex flex-col gap-2">
            {#each toolCall.askUser.questions as q, qi (qi)}
              <div class="flex flex-col gap-1">
                <div class="text-sm">{q.question}</div>
                {#if q.options}
                  <div class="flex flex-col gap-1">
                    {#each q.options as opt (opt.value)}
                      <button
                        type="button"
                        class="text-xs px-2 py-1 h-8 rounded cursor-pointer border text-left {drafts[
                          qi
                        ]?.picks.includes(opt.value)
                          ? 'bg-neutral-500 dark:bg-neutral-800 text-default-900 border-neutral-600 dark:border-neutral-900'
                          : 'bg-card-default hover:bg-neutral-500 dark:hover:bg-neutral-800 border-transparent'}"
                        title={opt.description}
                        onclick={() => togglePick(qi, opt.value, !!q.multiselect)}
                      >
                        {opt.label}
                      </button>
                    {/each}
                  </div>
                  {#if q.allowFreeformInput}
                    <input
                      type="text"
                      class="rounded block w-full h-8 px-2 outline-none text-xs border {drafts[
                        qi
                      ]?.freestyleActive
                        ? 'bg-neutral-500 dark:bg-neutral-800 text-default-900 border-neutral-600 dark:border-neutral-900'
                        : 'bg-card-default text-default-800 border-transparent'}"
                      placeholder="Or type your own..."
                      value={drafts[qi]?.text ?? ""}
                      oninput={(e) =>
                        setText(qi, (e.target as HTMLInputElement).value)}
                      onfocus={() => focusFreestyle(qi)}
                    />
                  {/if}
                {:else}
                  <input
                    type="text"
                    class="bg-card-default text-default-800 rounded block w-full h-8 px-2 outline-none text-xs"
                    value={drafts[qi]?.text ?? ""}
                    oninput={(e) =>
                      setText(qi, (e.target as HTMLInputElement).value)}
                  />
                {/if}
              </div>
            {/each}
            <button
              type="button"
              class="self-end text-xs px-3 py-1 rounded bg-card-default hover:bg-neutral-500 dark:hover:bg-neutral-800 text-default-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              disabled={!readyToSubmit(toolCall.askUser.questions)}
              onclick={submit}
            >
              Submit
            </button>
          </div>
        {/if}

        {#if hasCancelledError}
          <pre
            class="text-xs font-mono text-default-700 bg-card-default rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{toolCall.error}</pre>
        {/if}

        <div class="flex flex-col gap-1 text-xs">
          {#if hasArgs}
            <div class="text-default-600">Arguments</div>
            <pre
              class="text-default-800 bg-card-default rounded-md px-2 py-1 max-h-32 overflow-auto whitespace-pre">{argsText}</pre>
          {/if}
          {#if hasResult}
            <div class="text-default-600">Result</div>
            <pre
              class="text-default-800 bg-card-default rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{resultText}</pre>
          {/if}
          {#if hasError}
            <div class="text-default-600">Error</div>
            <pre
              class="font-mono text-default-800 bg-card-default rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{toolCall.error}</pre>
          {/if}
          {#if hasLogs}
            <div class="text-default-600">Logs</div>
            <div
              class="bg-card-default rounded-md px-2 py-1 max-h-32 overflow-auto flex flex-col gap-0.5 whitespace-pre"
            >
              {#each toolCall.logs as log, i (i)}
                <div class="text-default-700">
                  <span class="text-default-500">[{log.level}]</span>
                  {log.message}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/snippet}
  </Expandable>
</Bubble>

<style>
  /* Inline code pill matching MessageMarkdown's :global(code) treatment so
     the tool name in the header reads like a `code span` from the markdown
     renderer used in AgentMessage. */
  .tc-inline {
    background-color: rgba(30, 30, 30, 0.75);
    color: white;
    padding: 0.15em 0.4em;
    border-radius: 6px;
    margin-left: 0.25em;
    margin-right: 0.25em;
    font-size: 0.8em;
    font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace;
  }
</style>
