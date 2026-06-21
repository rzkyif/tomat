<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import RelevantToolsView from "@tomat/shared/ui/components/chat/messages/RelevantToolsView.svelte";
  import ToolCallView from "@tomat/shared/ui/components/chat/messages/ToolCallView.svelte";
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import MessageEnter from "@tomat/shared/ui/components/chat/MessageEnter.svelte";
  import { bubbleGap, useUiContext } from "@tomat/shared/ui/context";
  import type { AskUserQuestion } from "@tomat/shared";
  import hljs from "highlight.js/lib/core";
  import typescript from "highlight.js/lib/languages/typescript";
  import json from "highlight.js/lib/languages/json";
  import Cursor from "./Cursor.svelte";
  import BubbleShadow from "./BubbleShadow.svelte";
  import { Demo, type Timeline } from "../../lib/showcase";

  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("json", json);

  let { register, reportHeight }: {
    register: (h: { timeline: Timeline; reset: () => void }) => void;
    reportHeight: (h: number) => void;
  } = $props();

  // Fixed-height stage: the toolkit editor holds the top half while the chat
  // below scrolls. The chat starts as just the input, vertically centered, and
  // scrolls as the tool flow grows.
  const FRAME_H = 820;
  const REL_ID = "ct-relevant";
  const ui = useUiContext();

  // Top half: a hand-written toolkit, shown two-up (handler + manifest). This is
  // website-only editor chrome, not a client surface.
  const INDEX_TS = `import { dispenseFood } from "@acme/petnet";
import type { ToolContext } from "tomat:tool";

// the feed_cat tool
export async function feedCat(
  args: { portion?: string },
  ctx: ToolContext,
) {
  const [bowl] = await ctx.askUser([
    {
      question: "Which bowl should I fill?",
      options: [
        { label: "Kitchen", value: "kitchen" },
        { label: "Patio", value: "patio" },
      ],
    },
  ]);
  await dispenseFood({ bowl, grams: 45 });
  return { fed: true, bowl };
}`;
  const TOOLS_JSON = `{
  "name": "feed_cat",
  "description": "Dispense a portion from the smart feeder.",
  "parameters": {
    "type": "object",
    "properties": {
      "portion": { "type": "string" }
    }
  },
  "triggers": ["feed my cat", "feed Mochi"],
  "function": "feedCat",
  "permissions": { "net": ["petnet.local"] }
}`;
  const INDEX_HTML = hljs.highlight(INDEX_TS, { language: "typescript" }).value;
  const TOOLS_HTML = hljs.highlight(TOOLS_JSON, { language: "json" }).value;

  const PROMPT = "Feed Mochi, please.";
  const ANSWER = "All set. I filled the kitchen bowl with a 45g portion for Mochi.";
  const DECODE_TOKENS_PER_SEC = 25;
  const ANSWER_SECONDS = ANSWER.length / 4 / DECODE_TOKENS_PER_SEC;

  const feedQuestions: AskUserQuestion[] = [
    {
      question: "Which bowl should I fill?",
      options: [
        { label: "Kitchen", value: "kitchen", description: "the usual spot" },
        { label: "Patio", value: "patio" },
      ],
    },
  ];
  const feedAsk = { requestId: "feed-req", questions: feedQuestions };

  // Chat state, driven by the timeline.
  let inputValue = $state("");
  let userText = $state("");
  let showUser = $state(false);
  let showRelevant = $state(false);
  let showFeed = $state(false);
  let feedStatus = $state<"running" | "awaiting_user" | "completed">("running");
  let feedDrafts = $state<Record<number, { text: string; picks: string[]; freestyleActive: boolean; rows: string[][] }> | undefined>(undefined);
  let feedResult = $state<unknown>(undefined);
  let showAnswer = $state(false);
  let answerText = $state("");
  let answerStreaming = $state(false);

  let stageEl: HTMLElement | undefined = $state();
  let cursorRef: HTMLElement | undefined = $state();
  let chatScroll: HTMLElement | undefined = $state();

  function reset(): void {
    inputValue = "";
    userText = "";
    showUser = false;
    showRelevant = false;
    showFeed = false;
    feedStatus = "running";
    feedDrafts = undefined;
    feedResult = undefined;
    showAnswer = false;
    answerText = "";
    answerStreaming = false;
    ui.expansionSet(REL_ID, false);
    if (chatScroll) chatScroll.scrollTop = 0;
  }

  onMount(() => {
    let cancelled = false;
    let timeline: Timeline | undefined;
    reportHeight(FRAME_H);
    ui.expansionSet(REL_ID, false);
    void (async () => {
      if (cancelled || !stageEl || !cursorRef) return;
      const demo = new Demo(cursorRef, stageEl);
      demo.placeFrac(0.5, 0.7);

      const tl = gsap.timeline({ paused: true });
      timeline = tl;
      const input = 'textarea[aria-label="Message input"]';
      const send = 'button[title="Send"]';

      // 1. Glance over the toolkit files.
      demo.move(tl, '[data-pane="index"]', { duration: 0.9 });
      demo.hold(tl, 0.9);
      demo.move(tl, '[data-pane="tools"]', { duration: 0.7 });
      demo.hold(tl, 0.9);

      // 2. Trigger the tool by prompt.
      demo.move(tl, input, { duration: 0.7 });
      demo.click(tl, input);
      demo.type(tl, (v) => (inputValue = v), PROMPT, { duration: 1.3 });
      demo.hold(tl, 0.3);
      demo.move(tl, send, { duration: 0.6 });
      demo.hover(tl, send, true);
      demo.click(tl, send, () => {
        userText = PROMPT;
        inputValue = "";
        showUser = true;
      });
      demo.hover(tl, send, false);
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.5 });

      // 3. The relevant-tools bubble appears collapsed, then the agent's tool
      //    call follows right behind it and holds waiting for input (neither
      //    waits on a cursor click to appear).
      demo.hold(tl, 0.4);
      tl.add(() => (showRelevant = true));
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 0.4);
      tl.add(() => {
        showFeed = true;
        feedStatus = "running";
      });
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 0.45);
      tl.add(() => {
        feedStatus = "awaiting_user";
        feedDrafts = { 0: { text: "", picks: [], freestyleActive: false, rows: [] } };
      });
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 0.6);

      // 4. The cursor opens the relevant-tools card to inspect what matched...
      demo.move(tl, '[data-demo="relevant"]', { duration: 0.7 });
      demo.hover(tl, '[data-demo="relevant"]', true);
      demo.click(tl, '[data-demo="relevant"]', () => ui.expansionSet(REL_ID, true));
      demo.hover(tl, '[data-demo="relevant"]', false);
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 0.9);

      // ...then answers the tool's question.
      demo.move(tl, '[data-tc-nav]', { duration: 0.7 });
      demo.hover(tl, '[data-tc-nav]', true);
      demo.click(tl, '[data-tc-nav]', () => {
        feedDrafts = { 0: { text: "", picks: ["kitchen"], freestyleActive: false, rows: [] } };
      });
      demo.hover(tl, '[data-tc-nav]', false);
      demo.hold(tl, 0.7);
      // 5. The tool resumes and completes.
      tl.add(() => {
        feedStatus = "completed";
        feedDrafts = undefined;
        feedResult = { fed: true, bowl: "kitchen", grams: 45 };
      });
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 0.6);

      // 6. The agent's closing reply.
      tl.add(() => {
        showAnswer = true;
        answerStreaming = true;
      });
      demo.type(tl, (v) => (answerText = v), ANSWER, { duration: ANSWER_SECONDS });
      tl.add(() => (answerStreaming = false));
      demo.scroll(tl, () => chatScroll, 9999, { duration: 0.4 });
      demo.hold(tl, 1.6);

      register({
        timeline: tl,
        reset: () => {
          reset();
          tl.pause(0);
          demo.blur();
          demo.placeFrac(0.5, 0.7);
        },
      });
    })();
    return () => {
      cancelled = true;
      timeline?.kill();
    };
  });
</script>

<div bind:this={stageEl} class="relative w-full h-full overflow-hidden">
  <div class="w-[620px] h-full mx-auto flex flex-col gap-3 py-1">
    <!-- Top half: website-only editor chrome (not a client surface), two-up.
         Wears the shared bubble drop shadow + blur halo via BubbleShadow. -->
    <div class="relative shrink-0 h-[348px]">
      <BubbleShadow />
      <div class="bubble-promote relative z-10 h-full rounded-large overflow-hidden border border-default-200 bg-surface">
        <div class="grid grid-cols-2 h-full">
          <div data-pane="index" class="flex flex-col min-h-0">
            <div class="px-3 py-1.5 text-[11px] font-mono text-default-600 bg-surface">
              index.ts
            </div>
            <pre class="demo-code flex-1 min-h-0 overflow-hidden text-[10px] font-mono text-default-800 px-3 py-2 whitespace-pre leading-[1.45]">{@html INDEX_HTML}</pre>
          </div>
          <div data-pane="tools" class="flex flex-col min-h-0">
            <div class="px-3 py-1.5 text-[11px] font-mono text-default-600 bg-surface">
              tools.json
            </div>
            <pre class="demo-code flex-1 min-h-0 overflow-hidden text-[10px] font-mono text-default-800 px-3 py-2 whitespace-pre leading-[1.45]">{@html TOOLS_HTML}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom half: the real shared chat surface, scrollable; input centered
         until the tool flow grows past the viewport. -->
    <div bind:this={chatScroll} class="flex-1 min-h-0 overflow-y-auto no-scrollbar">
      <div class="min-h-full flex flex-col justify-center" style:gap={bubbleGap(ui)}>
        {#if showUser}
          <MessageEnter>
            <UserMessageView text={userText} />
          </MessageEnter>
        {/if}
        {#if showRelevant}
          <MessageEnter>
            <div data-demo="relevant">
              <RelevantToolsView
                id={REL_ID}
                phase1={[
                  { toolId: "petcare.feed_cat", name: "feed_cat", description: "Dispense a portion from the smart feeder.", score: 0.82 },
                  { toolId: "home.show_todos", name: "show_todos", description: "Show today's todo list.", score: 0.41 },
                ]}
                phase2={[
                  { toolId: "petcare.feed_cat", name: "feed_cat", description: "Dispense a portion from the smart feeder." },
                ]}
              />
            </div>
          </MessageEnter>
        {/if}
        {#if showFeed}
          <MessageEnter>
            <ToolCallView
              toolName="feed_cat"
              status={feedStatus}
              description={feedStatus === "running" ? "Dispensing" : undefined}
              progress={feedStatus === "running" ? 0.5 : undefined}
              askUser={feedStatus === "awaiting_user" ? feedAsk : undefined}
              draftsOverride={feedDrafts}
              result={feedResult}
            />
          </MessageEnter>
        {/if}
        {#if showAnswer}
          <MessageEnter>
            <AgentMessageView kind="content" bgClass="bubble-agent">
              {#snippet body()}
                <span class="whitespace-pre-wrap break-words">{answerText}</span>
              {/snippet}
            </AgentMessageView>
          </MessageEnter>
        {/if}
        <UserInputView bind:value={inputValue} placeholder="Enter your instructions..." />
      </div>
    </div>
  </div>
  <Cursor bind:ref={cursorRef} />
</div>
