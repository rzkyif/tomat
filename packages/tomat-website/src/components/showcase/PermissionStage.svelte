<script lang="ts">
  import { onMount, tick } from "svelte";
  import gsap from "gsap";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import MessageEnter from "@tomat/shared/ui/components/chat/MessageEnter.svelte";
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import ToolCallView from "@tomat/shared/ui/components/chat/messages/ToolCallView.svelte";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
  import PermissionRequestView from "@tomat/shared/ui/components/chat/userinput/PermissionRequestView.svelte";
  import PromptButtonsView from "@tomat/shared/ui/components/chat/userinput/PromptButtonsView.svelte";
  import Bubble from "@tomat/shared/ui/components/primitives/Bubble.svelte";
  import { bubbleGap, useUiContext } from "@tomat/shared/ui/context";
  import type { ToolCallStatus } from "@tomat/shared";
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

  // A guarded tool pauses for permission: the composer becomes the permission
  // review (a shield line + the exact command) with Deny / Allow, exactly as in
  // the app. Allowing resumes the tool, which completes and the agent replies.
  const PROMPT = "Push my changes to origin.";
  const ANSWER = "Pushed 3 commits to origin/main.";
  const DECODE_TOKENS_PER_SEC = 25;
  const ANSWER_SECONDS = ANSWER.length / 4 / DECODE_TOKENS_PER_SEC;

  const ALLOW_TITLE = "Allow for this tool call";
  const RESULT = { pushed: 3, branch: "origin/main" };

  let inputValue = $state("");
  let userText = $state("");
  let agentText = $state("");
  let showUser = $state(false);
  let showTool = $state(false);
  let toolStatus = $state<ToolCallStatus>("running");
  let toolResult = $state<unknown>(undefined);
  let inPromptMode = $state(false);
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
    showTool = false;
    toolStatus = "running";
    toolResult = undefined;
    inPromptMode = false;
    showAnswer = false;
  }

  // Two layouts share this stage (the permission review vs the final reply), so
  // measure both and size the frame to the taller one.
  async function measureContentHeight(): Promise<void> {
    measuring = true;
    showUser = true;
    userText = PROMPT;
    // Permission-review frame.
    showTool = true;
    toolStatus = "awaiting_permission";
    inPromptMode = true;
    await tick();
    const hPrompt = columnEl ? await awaitStableHeight(columnEl) : 0;
    // Final-reply frame.
    inPromptMode = false;
    toolStatus = "completed";
    toolResult = RESULT;
    showAnswer = true;
    agentText = ANSWER;
    await tick();
    const hReply = columnEl ? await awaitStableHeight(columnEl) : 0;
    reportHeight(Math.max(hPrompt, hReply));
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
      const allow = `button[title="${ALLOW_TITLE}"]`;

      demo.move(tl, input, { duration: 0.8 });
      demo.click(tl, input);
      demo.type(tl, (v) => (inputValue = v), PROMPT, { duration: 1.3 });
      demo.hold(tl, 0.3);
      demo.move(tl, send, { duration: 0.7 });
      demo.hover(tl, send, true);
      demo.click(tl, send, () => {
        userText = PROMPT;
        inputValue = "";
        showUser = true;
      });
      demo.hover(tl, send, false);
      tl.add(() => {
        showTool = true;
        toolStatus = "running";
      });
      demo.hold(tl, 0.6);
      // The tool needs permission: the composer becomes the review form.
      tl.add(() => {
        toolStatus = "awaiting_permission";
        inPromptMode = true;
      });
      demo.hold(tl, 1.4);
      // Allow it.
      demo.move(tl, allow, { duration: 0.7 });
      demo.hover(tl, allow, true);
      demo.click(tl, allow, () => {
        inPromptMode = false;
        toolStatus = "completed";
        toolResult = RESULT;
      });
      demo.hover(tl, allow, false);
      demo.hold(tl, 0.5);
      tl.add(() => (showAnswer = true));
      demo.type(tl, (v) => (agentText = v), ANSWER, { duration: ANSWER_SECONDS });
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
      {#if showTool}
        <MessageEnter enabled={!measuring}>
          <ToolCallView
            toolName="shell"
            status={toolStatus}
            description={toolStatus === "running" ? "Running" : undefined}
            result={toolResult}
          />
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
      <!-- The permission review: the shared shield line + the Deny / Allow
           buttons, the exact components the client renders. It sits above the
           composer (which keeps its real controls, e.g. the monitor / alignment
           / settings group), since the website lint forbids re-composing the
           composer itself (check-website-composer). -->
      {#if inPromptMode}
        <Bubble selectedAlignment={ui.getAlignment()} extraClass="flex flex-col gap-4">
          <PermissionRequestView
            toolName="shell"
            action="run a program"
            detail="git push origin main"
            declared
          />
          <div class="flex justify-end">
            <PromptButtonsView
              buttons={[
                {
                  icon: "i-material-symbols-close-rounded",
                  label: "Deny",
                  title: "Reject this permission request",
                  onClick: () => {},
                },
                {
                  icon: "i-material-symbols-check-rounded",
                  label: "Allow",
                  title: ALLOW_TITLE,
                  onClick: () => {},
                },
              ]}
            />
          </div>
        </Bubble>
      {/if}
      <UserInputView bind:value={inputValue} placeholder="Enter your instructions..." />
    </div>
  </div>
  <Cursor bind:ref={cursorRef} />
</div>
