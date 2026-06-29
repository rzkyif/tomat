<script lang="ts">
  import { onMount, tick } from "svelte";
  import gsap from "gsap";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import MessageEnter from "@tomat/shared/ui/components/chat/MessageEnter.svelte";
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import RelevantMemoriesView from "@tomat/shared/ui/components/chat/messages/RelevantMemoriesView.svelte";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
  import { bubbleGap, useUiContext } from "@tomat/shared/ui/context";
  import Cursor from "./Cursor.svelte";
  import { awaitStableHeight, Demo, type Timeline } from "../../lib/showcase";

  const ui = useUiContext();

  let {
    register,
    reportHeight,
  }: {
    register: (h: { timeline: Timeline; reset: () => void }) => void;
    reportHeight: (h: number) => void;
  } = $props();

  const PROMPT =
    "Draft my standup from these notes: shipped the import flow yesterday, on the export bug today, no blockers.";
  const ANSWER =
    "Here's your standup:\n\nYesterday: shipped the import flow.\nToday: on the export bug.\nBlockers: none.\n\nHeads up: posting now lands mid-evening for the US Pacific team, so you might wait until your afternoon.";

  const DECODE_TOKENS_PER_SEC = 25;
  const ANSWER_SECONDS = ANSWER.length / 4 / DECODE_TOKENS_PER_SEC;

  // Two recalled memories: one knowledge fact and one skill, each with its
  // relevance score, exactly as the "Found N relevant memories" bubble lists them.
  // The draft applies both (the skill's format, the fact's timezone aside) with
  // no tool call, so the demo shows recall without needing an external action.
  const MEMORIES = [
    {
      memoryId: "s1",
      title: "Skill: write a standup update",
      score: 0.89,
      summary: "Yesterday / today / blockers, one short line each.",
    },
    {
      memoryId: "k1",
      title: "Team timezone",
      score: 0.82,
      summary: "The team is mostly US Pacific; you're in CET.",
    },
  ];

  let inputValue = $state("");
  let userText = $state("");
  let agentText = $state("");
  let showUser = $state(false);
  let showMemories = $state(false);
  let showAnswer = $state(false);
  let measuring = $state(false);

  let stageEl: HTMLElement | undefined = $state();
  let cursorRef: HTMLElement | undefined = $state();
  let columnEl: HTMLElement | undefined = $state();

  function reset(): void {
    inputValue = "";
    userText = "";
    agentText = "";
    showUser = false;
    showMemories = false;
    showAnswer = false;
  }

  async function measureContentHeight(): Promise<void> {
    measuring = true;
    showUser = true;
    showMemories = true;
    showAnswer = true;
    userText = PROMPT;
    agentText = ANSWER;
    // Wait for the expanded "relevant memories" bubble (and fonts) to settle to a
    // stable height before measuring, so the frame never under-measures and clips
    // the column top and bottom.
    await tick();
    if (columnEl) reportHeight(await awaitStableHeight(columnEl));
    reset();
    measuring = false;
    await tick();
  }

  onMount(() => {
    let cancelled = false;
    let timeline: Timeline | undefined;
    void (async () => {
      if (!stageEl || !cursorRef) return;
      const demo = new Demo(cursorRef, stageEl);
      demo.placeFrac(0.5, 0.6);
      await measureContentHeight();
      if (cancelled) return;

      const tl = gsap.timeline({ paused: true });
      timeline = tl;
      const input = 'textarea[aria-label="Message input"]';
      const send = 'button[title="Send"]';

      demo.move(tl, input, { duration: 0.8 });
      demo.click(tl, input);
      demo.type(tl, (v) => (inputValue = v), PROMPT, { duration: 1.8 });
      demo.hold(tl, 0.3);
      demo.move(tl, send, { duration: 0.7 });
      demo.hover(tl, send, true);
      demo.click(tl, send, () => {
        userText = PROMPT;
        inputValue = "";
        showUser = true;
      });
      demo.hover(tl, send, false);
      tl.add(() => (showMemories = true));
      tl.add(() => (showAnswer = true));
      demo.type(tl, (v) => (agentText = v), ANSWER, {
        duration: ANSWER_SECONDS,
      });
      register({
        timeline: tl,
        reset: () => {
          reset();
          tl.pause(0);
          demo.blur();
          demo.placeFrac(0.5, 0.6);
        },
      });
    })();
    return () => {
      cancelled = true;
      timeline?.kill();
    };
  });
</script>

<div
  bind:this={stageEl}
  class="relative w-full h-full overflow-hidden flex items-center justify-center"
>
  <div class="shrink-0">
    <div bind:this={columnEl} class="w-[620px] flex flex-col" style:gap={bubbleGap(ui)}>
      {#if showUser}
        <MessageEnter enabled={!measuring}>
          <UserMessageView text={userText} />
        </MessageEnter>
      {/if}
      {#if showMemories}
        <MessageEnter enabled={!measuring}>
          <RelevantMemoriesView memories={MEMORIES} defaultExpanded />
        </MessageEnter>
      {/if}
      {#if showAnswer}
        <MessageEnter enabled={!measuring}>
          <AgentMessageView kind="content" bgClass="bubble-agent">
            {#snippet body()}
              <span class="whitespace-pre-wrap break-words">{agentText}</span>
            {/snippet}
          </AgentMessageView>
        </MessageEnter>
      {/if}
      <UserInputView bind:value={inputValue} placeholder="Enter your instructions..." />
    </div>
  </div>
  <Cursor bind:ref={cursorRef} />
</div>
