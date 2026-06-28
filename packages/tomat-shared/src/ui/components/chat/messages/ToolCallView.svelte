<script module lang="ts">
  // Working copy of in-flight askUser answers, indexed by question number.
  // Exported so a host scripting the form (e.g. the website showcase) can
  // build a `draftsOverride` snapshot. `picks` holds option values (also the
  // diff verdict, file paths, and the image action); `freestyleActive` means
  // the freeform text currently counts as an answer; `rows` is the editable
  // grid of a table question.
  export type DraftAnswer = {
    text: string;
    picks: string[];
    freestyleActive: boolean;
    rows: string[][];
  };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import type {
    AskUserAnswer,
    AskUserChoiceQuestion,
    AskUserQuestion,
    ToolCallStatus,
  } from "../../../../domain/session.ts";
  import Bubble from "../../primitives/Bubble.svelte";
  import Expandable from "../../primitives/Expandable.svelte";
  import Expand from "../../primitives/Expand.svelte";
  import DiffView from "./DiffView.svelte";
  import ErrorDetailView from "./ErrorDetailView.svelte";
  import DiffQuestion from "./askuser/DiffQuestion.svelte";
  import FilesQuestion from "./askuser/FilesQuestion.svelte";
  import ImageQuestion from "./askuser/ImageQuestion.svelte";
  import TableQuestion from "./askuser/TableQuestion.svelte";
  import ChoiceQuestion from "./askuser/ChoiceQuestion.svelte";
  import { useUiContext } from "../../../context.ts";

  // Presentational tool-call bubble: the status-phrase header, the args /
  // result / error / logs blocks, and the full askUser interactive form. The
  // client wraps this feeding live message + ephemera state; the website feeds
  // scripted state (and drives the form via `draftsOverride`). Alignment and
  // the system-message theme override come from the shared UI context; the
  // agent name and the memory-result markdown renderer are injected, so this
  // stays free of client stores and the markdown pipeline.
  const ui = useUiContext();
  const themeOverrideHex = $derived(ui.systemMessageDefaultColor ?? null);

  type AskUserPayload = { requestId: string; questions: AskUserQuestion[] };
  type LogLine = { level: string; message: string };

  let {
    toolName,
    status = "completed",
    label = undefined,
    description = undefined,
    args = {},
    result = undefined,
    error = undefined,
    progress = undefined,
    logs = [],
    askUser = undefined,
    agentName = "",
    draftsOverride = undefined,
    neighborLeft = false,
    neighborRight = false,
    onAnswer = () => {},
    memoryContent = undefined,
    expanded = $bindable(false),
  }: {
    toolName: string;
    status?: ToolCallStatus;
    label?: string;
    description?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    progress?: number;
    logs?: LogLine[];
    askUser?: AskUserPayload;
    /** Agent name for the status phrase; falls back to "Agent" when empty. */
    agentName?: string;
    /** Scripted render source for the form. When set, the form renders from
     *  these drafts and the live interaction effects (auto-focus, auto-submit,
     *  internal mutation) are bypassed. Undefined = live client interaction. */
    draftsOverride?: Record<number, DraftAnswer>;
    neighborLeft?: boolean;
    neighborRight?: boolean;
    onAnswer?: (requestId: string, answers: AskUserAnswer[]) => void;
    /** Renders the `memory_content` result. Client passes MessageMarkdown;
     *  when absent the raw text is shown in a <pre>. */
    memoryContent?: Snippet<[{ title: string; content: string }]>;
    expanded?: boolean;
  } = $props();

  // Aliases so the body below reads against stable names.
  let tcStatus = $derived(status);
  let tcAskUser = $derived(askUser);
  let tcLogs = $derived(logs);
  let tcArgs = $derived(args);

  // Auto-open when the tool enters `awaiting_user` so the user can answer, and
  // auto-close once the tool reaches a terminal state, but ONLY if it actually
  // went through awaiting_user earlier (so a non-interactive call that ran
  // straight to "completed" is never forcibly collapsed against a manual
  // expansion).
  let wasAwaiting = $state(false);
  $effect(() => {
    const s = tcStatus;
    if (s === "awaiting_user") {
      expanded = true;
      wasAwaiting = true;
    } else if (
      wasAwaiting &&
      (s === "completed" || s === "failed" || s === "cancelled")
    ) {
      expanded = false;
      wasAwaiting = false;
    }
  });

  // Live working copy of askUser answers (client path). The website path leaves
  // this empty and supplies `draftsOverride` instead.
  let drafts: Record<number, DraftAnswer> = $state({});
  // The drafts the markup renders from: scripted override or the live copy.
  let renderDrafts = $derived(draftsOverride ?? drafts);
  // Tracks which freeform inputs currently have focus. A single-select question
  // with `allowFreeformInput` defaults to "auto-submit on option click", but
  // focusing the text input flips it into "manual submit" mode.
  let freeformFocused: Record<number, boolean> = $state({});
  let lastSeenRequestId: string | null = $state(null);

  function ensureDrafts(questions: AskUserQuestion[], requestId: string) {
    if (lastSeenRequestId === requestId) return;
    const next: Record<number, DraftAnswer> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      next[i] = {
        ...blankDraft(),
        rows: q.kind === "table" ? q.rows.map((r) => [...r]) : [],
      };
    }
    drafts = next;
    freeformFocused = {};
    lastSeenRequestId = requestId;
  }

  // Frames that predate the kind discriminator carry no kind and mean "choice".
  function isChoice(q: AskUserQuestion): q is AskUserChoiceQuestion {
    return q.kind === undefined || q.kind === "choice";
  }

  $effect(() => {
    if (draftsOverride) return;
    if (tcAskUser && tcStatus === "awaiting_user") {
      ensureDrafts(tcAskUser.questions, tcAskUser.requestId);
    }
  });

  function blankDraft(): DraftAnswer {
    return { text: "", picks: [], freestyleActive: false, rows: [] };
  }

  function togglePick(idx: number, value: string, multi: boolean) {
    const d = drafts[idx] ?? blankDraft();
    if (multi) {
      const set = new Set(d.picks);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      drafts[idx] = { ...d, picks: Array.from(set) };
    } else {
      drafts[idx] = { ...d, picks: [value], freestyleActive: false };
    }
  }

  function setText(idx: number, text: string) {
    const d = drafts[idx] ?? blankDraft();
    const active = text.trim().length > 0;
    const q = tcAskUser?.questions[idx];
    const multi = !!(q && isChoice(q) && q.multiselect);
    drafts[idx] = {
      ...d,
      text,
      picks: !multi && active ? [] : d.picks,
      freestyleActive: active,
    };
  }

  function focusFreestyle(idx: number) {
    const d = drafts[idx] ?? blankDraft();
    if (d.text.trim().length === 0) return;
    const q = tcAskUser?.questions[idx];
    if (q && isChoice(q) && q.multiselect) return;
    if (d.freestyleActive && d.picks.length === 0) return;
    drafts[idx] = { ...d, picks: [], freestyleActive: true };
  }

  // Table-grid editing. Rows are replaced immutably so the $state proxy sees
  // every change; an empty grid is a valid answer ("none of these").
  function setCell(idx: number, row: number, col: number, value: string) {
    const d = drafts[idx] ?? blankDraft();
    if (!d.rows[row]) return;
    const rows = d.rows.map((r) => [...r]);
    rows[row][col] = value;
    drafts[idx] = { ...d, rows };
  }

  function addRow(idx: number, columns: number) {
    const d = drafts[idx] ?? blankDraft();
    drafts[idx] = {
      ...d,
      rows: [...d.rows, Array.from({ length: columns }, () => "")],
    };
  }

  function removeRow(idx: number, row: number) {
    const d = drafts[idx] ?? blankDraft();
    drafts[idx] = { ...d, rows: d.rows.filter((_, i) => i !== row) };
  }

  function readyToSubmit(questions: AskUserQuestion[]): boolean {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const d = drafts[i] ?? blankDraft();
      if (!isChoice(q)) {
        if (q.kind === "table") continue;
        if (q.kind === "files" && q.multiselect) continue;
        if (d.picks.length === 0) return false;
        continue;
      }
      if (!q.options) {
        if (!d.text.trim()) return false;
        continue;
      }
      const hasFreestyle =
        !!q.allowFreeformInput && d.freestyleActive && !!d.text.trim();
      if (d.picks.length === 0 && !hasFreestyle) return false;
    }
    return true;
  }

  // Idempotent per requestId: both the auto-submit effect and direct submits
  // funnel through here, and the host's status flip after `onAnswer` is async,
  // so without a guard the same answer would post twice.
  let lastSubmittedRequestId: string | null = $state(null);

  function answerFor(q: AskUserQuestion, d: DraftAnswer): AskUserAnswer {
    if (q.kind === "diff" || q.kind === "image") return d.picks[0] ?? "";
    if (q.kind === "files") return q.multiselect ? d.picks : (d.picks[0] ?? "");
    if (q.kind === "table") {
      return d.rows.map((row) =>
        Object.fromEntries(q.columns.map((c, i) => [c, row[i] ?? ""])),
      );
    }
    if (!q.options) return d.text.trim();
    const text = d.text.trim();
    if (q.multiselect) {
      const all = [...d.picks];
      if (q.allowFreeformInput && text.length > 0) all.push(text);
      return all;
    }
    const useFreestyle =
      !!q.allowFreeformInput && d.freestyleActive && text.length > 0;
    return useFreestyle ? text : (d.picks[0] ?? "");
  }

  function submit() {
    if (!tcAskUser) return;
    const requestId = tcAskUser.requestId;
    if (lastSubmittedRequestId === requestId) return;
    const qs = tcAskUser.questions;
    const answers: AskUserAnswer[] = [];
    for (let i = 0; i < qs.length; i++) {
      answers.push(answerFor(qs[i], drafts[i] ?? blankDraft()));
    }
    lastSubmittedRequestId = requestId;
    onAnswer(requestId, answers);
  }

  // A session needs an explicit submit button when *any* question can't resolve
  // from a single click. Plain-text, multiselect (choice or files), and table
  // questions always count; diff, image, and single-select files resolve from
  // one click. For single-select-with-freeform, the question only counts while
  // the freeform input is "engaged" (focused, or has typed text).
  let requiresSubmit = $derived.by(() => {
    if (!tcAskUser) return false;
    const qs = tcAskUser.questions;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (q.kind === "diff" || q.kind === "image") continue;
      if (q.kind === "files") {
        if (q.multiselect) return true;
        continue;
      }
      if (q.kind === "table") return true;
      if (!q.options) return true;
      if (q.multiselect) return true;
      if (q.allowFreeformInput) {
        const engaged =
          freeformFocused[i] === true || (drafts[i]?.freestyleActive ?? false);
        if (engaged) return true;
      }
    }
    return false;
  });

  $effect(() => {
    if (draftsOverride) return;
    if (!tcAskUser || tcStatus !== "awaiting_user") return;
    if (requiresSubmit) return;
    if (!readyToSubmit(tcAskUser.questions)) return;
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
  // [data-tc-nav] elements, Enter activates buttons and submits when ready.
  // While `keyboardNav` is true, hover preview styling is suppressed so the
  // focused element's inversion preview is the only highlight visible.
  let keyboardNav = $state(false);
  function onContainerKeydown(e: KeyboardEvent) {
    if (!tcAskUser) return;
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
        idx === -1
          ? offset > 0
            ? 0
            : items.length - 1
          : (idx + offset + items.length) % items.length;
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
          if (target.hasAttribute("data-tc-aux")) return;
        }
        if (readyToSubmit(tcAskUser.questions)) submit();
        return;
    }
  }
  function onContainerPointerMove() {
    if (keyboardNav) keyboardNav = false;
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      active.tagName === "BUTTON" &&
      askUserContainer?.contains(active)
    ) {
      active.blur();
    }
  }

  // Wrapper text around the tool name, keyed by status. When `label` is set the
  // whole sentence is replaced by that label.
  let statusPhrase = $derived.by(() => {
    const agent = (agentName || "").trim() || "Agent";
    switch (tcStatus) {
      case "awaiting_user":
        return { pre: `${agent} awaiting input for `, post: " tool:" };
      case "awaiting_permission":
        return { pre: `${agent} awaiting permission for `, post: " tool." };
      case "completed":
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

  let percent = $derived(
    typeof progress === "number" ? Math.round(progress * 100) : null,
  );
  let isActive = $derived(tcStatus === "pending" || tcStatus === "running");
  let showProgress = $derived(isActive);

  // Well-known result kinds get a dedicated renderer instead of raw JSON: the
  // memory tools return `memory_diff` (before/after) and `memory_content`
  // (full markdown).
  let memoryDiff = $derived.by<{ title: string; before: string; after: string } | null>(() => {
    const r = result as Record<string, unknown> | undefined;
    if (
      !r || typeof r !== "object" || r.kind !== "memory_diff" ||
      typeof r.before !== "string" || typeof r.after !== "string"
    ) {
      return null;
    }
    return {
      title: typeof r.title === "string" ? r.title : "",
      before: r.before,
      after: r.after,
    };
  });
  let memoryResult = $derived.by<{ title: string; content: string } | null>(() => {
    const r = result as Record<string, unknown> | undefined;
    if (
      !r || typeof r !== "object" || r.kind !== "memory_content" ||
      typeof r.content !== "string"
    ) {
      return null;
    }
    return {
      title: typeof r.title === "string" ? r.title : "",
      content: r.content,
    };
  });

  let resultText = $derived.by(() => {
    if (result === undefined) return "";
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  });

  let argsText = $derived.by(() => {
    try {
      return JSON.stringify(tcArgs ?? {}, null, 2);
    } catch {
      return "";
    }
  });

  let hasArgs = $derived(!!tcArgs && Object.keys(tcArgs).length > 0);
  let hasLogs = $derived(tcLogs.length > 0);
  let hasResult = $derived(tcStatus === "completed" && result !== undefined);
  let hasError = $derived(tcStatus === "failed" && !!error);
  let hasCancelledError = $derived(tcStatus === "cancelled" && !!error);
  let hasAskUser = $derived(tcStatus === "awaiting_user" && !!tcAskUser);
  let hasBody = $derived(
    !!description ||
      hasArgs ||
      hasLogs ||
      hasResult ||
      hasError ||
      hasCancelledError ||
      hasAskUser,
  );

  let awaitingInput = $derived(
    tcStatus === "awaiting_user" || tcStatus === "awaiting_permission",
  );

  // States that color the whole bubble: a failed call reads red, awaiting input
  // reads yellow. `accent` retints the bubble fill AND every nested `-default-`
  // color (insets, text, the askUser controls with their hover/focus/selected
  // states) to the hue, so the call is themed end to end rather than only at the
  // border. Other states stay on the neutral surface.
  let accent: "red" | "yellow" | undefined = $derived(
    tcStatus === "failed" ? "red" : awaitingInput ? "yellow" : undefined,
  );

  // Mobile chat bubbles always sit on the agent side (left); desktop follows the
  // window-alignment setting.
  let alignment = $derived(ui.platform === "mobile" ? "left" : ui.getAlignment());
  // Floor the bubble width only while expanded so the body doesn't squish; when
  // collapsed the bubble shrink-wraps the label + description.
  let bubbleExtraClass = $derived(
    expanded ? "text-default-800 min-w-60" : "text-default-800",
  );

  // Selected vs. unselected styling for option buttons and the freeform input.
  let unselectedClasses = $derived(
    keyboardNav
      ? "bg-surface-inset text-default-800 focus:bg-surface-inset-strong"
      : "bg-surface-inset text-default-800 hover:bg-surface-inset-strong",
  );
  const selectedClasses = "bg-default-inverted-200 text-default-inverted-800";

  // Auto-focus the first nav element when input mode begins so the user can
  // start typing or arrow-navigate without first reaching for the mouse.
  let askUserContainer: HTMLDivElement | undefined = $state();
  let autoFocusedRequestId: string | null = $state(null);
  $effect(() => {
    if (draftsOverride) return;
    if (!tcAskUser || tcStatus !== "awaiting_user") return;
    const requestId = tcAskUser.requestId;
    if (untrack(() => autoFocusedRequestId) === requestId) return;
    if (!askUserContainer) return;
    const first = askUserContainer.querySelector<HTMLElement>("[data-tc-nav]");
    if (!first) return;
    first.focus();
    autoFocusedRequestId = requestId;
  });
</script>

<div style:display="contents" style:--default-base={themeOverrideHex}>
<Bubble
  selectedAlignment={alignment}
  size="small"
  {accent}
  extraClass={bubbleExtraClass}
  progress={showProgress ? percent : undefined}
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded {alignment} disabled={!hasBody}>
    {#snippet title()}
      <span>
        {#if label}
          {label}
        {:else}
          {statusPhrase.pre}<code
            class="font-mono bg-surface-inset text-default-800 rounded-small px-1.5 py-0.5 text-[0.8em] mx-1"
          >{toolName}</code>{statusPhrase.post}
        {/if}
      </span>
      {#if description && !expanded}
        <span class="text-default-600 truncate">{description}</span>
      {/if}
    {/snippet}
    {#snippet children()}
      <!-- Body content is intentionally alignment-independent: `text-left`
           overrides the Expandable wrapper's `text-right` so questions, args,
           results, and error/log blocks always read left-to-right. -->
      <div class="flex flex-col gap-2 text-left">
        {#if description}
          <div
            class="text-xs text-default-600 {alignment === 'right'
              ? 'text-right'
              : ''}"
          >
            {description}
          </div>
        {/if}

        {#if hasAskUser && tcAskUser}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            bind:this={askUserContainer}
            class="flex flex-col gap-2"
            onkeydown={onContainerKeydown}
            onpointermove={onContainerPointerMove}
          >
            {#each tcAskUser.questions as q, qi (qi)}
              <div class="flex flex-col gap-2">
                <div class="text-sm">{q.question}</div>
                {#if q.kind === "diff"}
                  <DiffQuestion
                    {q}
                    {qi}
                    draft={renderDrafts[qi]}
                    {selectedClasses}
                    {unselectedClasses}
                    {togglePick}
                  />
                {:else if q.kind === "files"}
                  <FilesQuestion
                    {q}
                    {qi}
                    draft={renderDrafts[qi]}
                    {selectedClasses}
                    {unselectedClasses}
                    {togglePick}
                  />
                {:else if q.kind === "image"}
                  <ImageQuestion
                    {q}
                    {qi}
                    draft={renderDrafts[qi]}
                    {selectedClasses}
                    {unselectedClasses}
                    {togglePick}
                  />
                {:else if q.kind === "table"}
                  <TableQuestion
                    {q}
                    {qi}
                    draft={renderDrafts[qi]}
                    {unselectedClasses}
                    {setCell}
                    {addRow}
                    {removeRow}
                  />
                {:else}
                  <ChoiceQuestion
                    {q}
                    {qi}
                    draft={renderDrafts[qi]}
                    {selectedClasses}
                    {unselectedClasses}
                    {togglePick}
                    {setText}
                    {onFreestyleFocus}
                    {onFreestyleBlur}
                  />
                {/if}
              </div>
            {/each}
            <Expand open={requiresSubmit && readyToSubmit(tcAskUser.questions)}>
              <button
                type="button"
                data-tc-nav
                class="w-full text-xs px-3 h-8 rounded bg-surface-inset text-default-800 cursor-pointer outline-none transition-colors duration-100"
                onclick={submit}
              >
                Submit
              </button>
            </Expand>
          </div>
        {/if}

        {#if hasCancelledError}
          <ErrorDetailView detail={error} />
        {/if}

        <div class="flex flex-col gap-1 text-xs">
          {#if hasArgs}
            <div class="text-default-600">Arguments</div>
            <pre
              class="tomat-scroll-inset text-default-800 bg-surface-inset rounded-small px-2 py-1 max-h-32 overflow-auto whitespace-pre">{argsText}</pre>
          {/if}
          {#if hasResult}
            {#if memoryDiff}
              <div class="text-default-600">
                Changes{memoryDiff.title ? ` to "${memoryDiff.title}"` : ""}
              </div>
              <div class="max-h-48 overflow-auto">
                <DiffView before={memoryDiff.before} after={memoryDiff.after} />
              </div>
            {:else if memoryResult}
              <div class="text-default-600">
                {memoryResult.title || "Memory"}
              </div>
              {#if memoryContent}
                <div
                  class="tomat-scroll-inset bg-surface-inset rounded-small px-2 py-1 max-h-48 overflow-auto"
                >
                  {@render memoryContent(memoryResult)}
                </div>
              {:else}
                <pre
                  class="tomat-scroll-inset text-default-800 bg-surface-inset rounded-small px-2 py-1 max-h-48 overflow-auto whitespace-pre-wrap">{memoryResult.content}</pre>
              {/if}
            {:else}
              <div class="text-default-600">Result</div>
              <pre
                class="tomat-scroll-inset text-default-800 bg-surface-inset rounded-small px-2 py-1 max-h-48 overflow-auto whitespace-pre">{resultText}</pre>
            {/if}
          {/if}
          {#if hasError}
            <ErrorDetailView detail={error} />
          {/if}
          {#if hasLogs}
            <div class="text-default-600">Logs</div>
            <div
              class="tomat-scroll-inset bg-surface-inset rounded-small px-2 py-1 max-h-32 overflow-auto flex flex-col gap-0.5 whitespace-pre"
            >
              {#each tcLogs as log, i (i)}
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
</div>
