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

  // Expansion state: shared with MessageStackGroup so the group can split
  // its substacks around this bubble when it opens. Read once via untrack
  // so the initial seed doesn't flip mid-render.
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
  // `picks` holds option values; `freestyleActive` means the freeform text
  // currently counts as an answer. Single-select treats picks and freestyle
  // as mutually exclusive (clicking an option demotes freestyle, typing
  // demotes picks); multiselect treats them as additive — picks and the
  // freestyle entry coexist and both contribute to the final answer array.
  type DraftAnswer = {
    text: string;
    picks: string[];
    freestyleActive: boolean;
  };
  let drafts: Record<number, DraftAnswer> = $state({});
  // Tracks which freeform inputs currently have focus. A single-select
  // question with `allowFreeformInput` defaults to "auto-submit on option
  // click", but focusing the text input flips it into "manual submit" mode
  // until the user clicks an option (which fires blur first, then auto-
  // submits the chosen option).
  let freeformFocused: Record<number, boolean> = $state({});
  let lastSeenRequestId: string | null = $state(null);

  function ensureDrafts(questions: AskUserQuestion[], requestId: string) {
    if (lastSeenRequestId === requestId) return;
    const next: Record<number, DraftAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      next[i] = { text: "", picks: [], freestyleActive: false };
    }
    drafts = next;
    freeformFocused = {};
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
    if (multi) {
      const set = new Set(d.picks);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      // Multiselect: picks and freestyle coexist, so toggling an option
      // leaves the freestyle entry alone.
      drafts[idx] = { ...d, picks: Array.from(set) };
    } else {
      // Single-select: clicking an option always wins over freestyle —
      // picks become the answer, freeform is marked inactive (but its text
      // is preserved so the user can come back to it).
      drafts[idx] = { ...d, picks: [value], freestyleActive: false };
    }
  }

  function setText(idx: number, text: string) {
    const d = drafts[idx] ?? blankDraft();
    const active = text.trim().length > 0;
    const multi = !!toolCall.askUser?.questions[idx]?.multiselect;
    drafts[idx] = {
      ...d,
      text,
      // Single-select: typing demotes any prior pick (mutual exclusivity).
      // Multiselect: keep picks alongside the freestyle entry.
      picks: !multi && active ? [] : d.picks,
      freestyleActive: active,
    };
  }

  function focusFreestyle(idx: number) {
    const d = drafts[idx] ?? blankDraft();
    if (d.text.trim().length === 0) return;
    // Multiselect: picks and freestyle coexist; freestyleActive is kept in
    // sync with the text by setText, so focusing doesn't need to promote.
    if (toolCall.askUser?.questions[idx]?.multiselect) return;
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

  // Idempotent per requestId: both the auto-submit effect and direct
  // user-driven submits (button click, Enter key) funnel through here, and
  // the parent's status flip after `onAnswer` is async, so without a guard
  // the same answer would post twice.
  let lastSubmittedRequestId: string | null = $state(null);

  function submit() {
    if (!toolCall.askUser) return;
    const requestId = toolCall.askUser.requestId;
    if (lastSubmittedRequestId === requestId) return;
    const qs = toolCall.askUser.questions;
    const answers: AskUserAnswer[] = [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const d = drafts[i] ?? blankDraft();
      if (!q.options) {
        answers.push(d.text.trim());
        continue;
      }
      const text = d.text.trim();
      if (q.multiselect) {
        // Multiselect: picks and freestyle text coexist as separate
        // contributions to the answer array.
        const all = [...d.picks];
        if (q.allowFreeformInput && text.length > 0) all.push(text);
        answers.push(all);
      } else {
        const useFreestyle =
          !!q.allowFreeformInput && d.freestyleActive && text.length > 0;
        answers.push(useFreestyle ? text : (d.picks[0] ?? ""));
      }
    }
    lastSubmittedRequestId = requestId;
    onAnswer(requestId, answers);
  }

  // A session needs an explicit submit button when *any* question can't
  // resolve from a single click. Plain-text and multiselect always count.
  // For single-select-with-freeform, the question only counts while the
  // freeform input is "engaged" (focused, or has typed text); otherwise the
  // expected interaction is "click an option → auto-submit".
  let requiresSubmit = $derived.by(() => {
    if (!toolCall.askUser) return false;
    const qs = toolCall.askUser.questions;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q.options) return true;
      if (q.multiselect) return true;
      if (q.allowFreeformInput) {
        const engaged =
          freeformFocused[i] === true ||
          (drafts[i]?.freestyleActive ?? false);
        if (engaged) return true;
      }
    }
    return false;
  });

  $effect(() => {
    if (!toolCall.askUser || toolCall.status !== "awaiting_user") return;
    if (requiresSubmit) return;
    if (!readyToSubmit(toolCall.askUser.questions)) return;
    submit();
  });

  function onFreestyleFocus(idx: number) {
    freeformFocused[idx] = true;
    focusFreestyle(idx);
  }

  function onFreestyleBlur(idx: number) {
    freeformFocused[idx] = false;
  }

  // Container-level keyboard navigation: arrows + Tab cycle focus across all
  // [data-tc-nav] elements (option buttons, text inputs, submit), Enter
  // activates buttons and submits when ready. We rely on
  // `e.currentTarget.querySelectorAll` rather than caching the list so it
  // always reflects the current DOM (questions/Submit can appear/disappear).
  // While `keyboardNav` is true, hover effects on nav elements are
  // suppressed so the focus border (driven by keyboard) is the only edge
  // highlight visible. Pointer movement re-enables hover.
  let keyboardNav = $state(false);
  function onContainerKeydown(e: KeyboardEvent) {
    if (!toolCall.askUser) return;
    const target = e.target as HTMLElement | null;
    const container = e.currentTarget as HTMLElement;
    if (!target || !container) return;

    const cycle = (offset: number) => {
      const items = Array.from(
        container.querySelectorAll<HTMLElement>("[data-tc-nav]"),
      ).filter(
        (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const idx = items.indexOf(target);
      const nextIdx =
        idx === -1 ? 0 : (idx + offset + items.length) % items.length;
      items[nextIdx].focus();
    };

    switch (e.key) {
      case "ArrowDown":
        keyboardNav = true;
        e.preventDefault();
        cycle(1);
        return;
      case "ArrowUp":
        keyboardNav = true;
        e.preventDefault();
        cycle(-1);
        return;
      case "Tab":
        keyboardNav = true;
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        return;
      case "Enter":
        e.preventDefault();
        if (target.tagName === "BUTTON") {
          (target as HTMLButtonElement).click();
        }
        if (readyToSubmit(toolCall.askUser.questions)) submit();
        return;
    }
  }
  function onContainerPointerMove() {
    if (keyboardNav) keyboardNav = false;
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

  let alignment = $derived(settingsState.getAlignment());
  // Floor the bubble width only while expanded — `min-w-60` prevents the body
  // (questions, args, results) from squishing into a sliver, but when
  // collapsed we want the bubble to shrink-wrap the label + description.
  let bubbleExtraClass = $derived(
    expanded ? "text-default-800 min-w-60" : "text-default-800",
  );

  // Mirrors the bubble's "active edge" treatment onto each input: a thick
  // border grows on the left side. Color is set globally (only the side
  // with non-zero width is visible) and width animates via the element's
  // own `transition-all duration-100`. Two intensities:
  //   - hover/focus (`edgeBorderClasses`): a dimmer hint, default-700.
  //     Hover effects are suppressed while `keyboardNav` is active so the
  //     focused element is the only one with an edge highlight when the
  //     user is arrow/tab-navigating.
  //   - selected   (`selectedBorderClasses`): a brighter persistent mark,
  //     default-900 — used for picked options and an active freestyle
  //     entry, replacing the old `bg-neutral-*` darkening.
  let edgeBorderClasses = $derived(
    keyboardNav
      ? "focus:border-l-8 focus:border-default-700"
      : "hover:border-l-8 focus:border-l-8 hover:border-default-700 focus:border-default-700",
  );
  let selectedBorderClasses = "border-l-8 border-default-900";

  // Auto-focus the first nav element when input mode begins so the user can
  // start typing (text input) or arrow-navigate (option button) without
  // first reaching for the mouse. `bind:this` updates `askUserContainer`
  // when the askUser block mounts; the effect then runs once per requestId.
  let askUserContainer: HTMLDivElement | undefined = $state();
  let autoFocusedRequestId: string | null = $state(null);
  $effect(() => {
    if (!toolCall.askUser || toolCall.status !== "awaiting_user") return;
    const requestId = toolCall.askUser.requestId;
    if (autoFocusedRequestId === requestId) return;
    if (!askUserContainer) return;
    const first =
      askUserContainer.querySelector<HTMLElement>("[data-tc-nav]");
    if (!first) return;
    first.focus();
    autoFocusedRequestId = requestId;
  });
</script>

<Bubble
  selectedAlignment={alignment}
  size="small"
  extraClass={bubbleExtraClass}
  active={borderActive}
  {borderColorClass}
  progress={showProgress ? percent : undefined}
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded {alignment} disabled={!hasBody}>
    {#snippet title()}
      <span>
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
      <!-- Body content is intentionally alignment-independent: `text-left`
           overrides the Expandable wrapper's `text-right` (applied when the
           bubble alignment is "right") so questions, args, results, and
           error/log blocks always read left-to-right. The title/header
           above still follows screen alignment. -->
      <div class="flex flex-col gap-2 text-left">
        {#if toolCall.description}
          <div class="text-xs text-default-600">{toolCall.description}</div>
        {/if}

        {#if hasAskUser && toolCall.askUser}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            bind:this={askUserContainer}
            class="flex flex-col gap-2"
            onkeydown={onContainerKeydown}
            onpointermove={onContainerPointerMove}
          >
            {#each toolCall.askUser.questions as q, qi (qi)}
              <div class="flex flex-col gap-1">
                <div class="text-sm">{q.question}</div>
                {#if q.options}
                  <div class="flex flex-col gap-1">
                    {#each q.options as opt (opt.value)}
                      <button
                        type="button"
                        data-tc-nav
                        class="text-xs px-2 py-1 h-8 rounded cursor-pointer text-left outline-none bg-default-200 transition-all duration-100 {drafts[
                          qi
                        ]?.picks.includes(opt.value)
                          ? selectedBorderClasses
                          : edgeBorderClasses}"
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
                      data-tc-nav
                      class="rounded block w-full h-8 px-2 outline-none text-xs bg-default-200 text-default-800 transition-all duration-100 {drafts[
                        qi
                      ]?.freestyleActive
                        ? selectedBorderClasses
                        : edgeBorderClasses}"
                      placeholder="Or type your own..."
                      value={drafts[qi]?.text ?? ""}
                      oninput={(e) =>
                        setText(qi, (e.target as HTMLInputElement).value)}
                      onfocus={() => onFreestyleFocus(qi)}
                      onblur={() => onFreestyleBlur(qi)}
                    />
                  {/if}
                {:else}
                  <input
                    type="text"
                    data-tc-nav
                    class="bg-default-200 text-default-800 rounded block w-full h-8 px-2 outline-none text-xs transition-all duration-100 {edgeBorderClasses}"
                    value={drafts[qi]?.text ?? ""}
                    oninput={(e) =>
                      setText(qi, (e.target as HTMLInputElement).value)}
                  />
                {/if}
              </div>
            {/each}
            {#if requiresSubmit}
              <button
                type="button"
                data-tc-nav
                class="self-end text-xs px-3 py-1 rounded bg-default-200 text-default-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer outline-none transition-all duration-100 {edgeBorderClasses}"
                disabled={!readyToSubmit(toolCall.askUser.questions)}
                onclick={submit}
              >
                Submit
              </button>
            {/if}
          </div>
        {/if}

        {#if hasCancelledError}
          <pre
            class="text-xs font-mono text-default-700 bg-default-200 rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{toolCall.error}</pre>
        {/if}

        <div class="flex flex-col gap-1 text-xs">
          {#if hasArgs}
            <div class="text-default-600">Arguments</div>
            <pre
              class="text-default-800 bg-default-200 rounded-md px-2 py-1 max-h-32 overflow-auto whitespace-pre">{argsText}</pre>
          {/if}
          {#if hasResult}
            <div class="text-default-600">Result</div>
            <pre
              class="text-default-800 bg-default-200 rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{resultText}</pre>
          {/if}
          {#if hasError}
            <div class="text-default-600">Error</div>
            <pre
              class="font-mono text-default-800 bg-default-200 rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre">{toolCall.error}</pre>
          {/if}
          {#if hasLogs}
            <div class="text-default-600">Logs</div>
            <div
              class="bg-default-200 rounded-md px-2 py-1 max-h-32 overflow-auto flex flex-col gap-0.5 whitespace-pre"
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
