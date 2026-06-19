<script lang="ts">
  // A small static chat snippet for the manual, built from the SAME message
  // bubbles the app renders (no provider mounted, so DEFAULT_UI_CONTEXT supplies
  // the app's default settings). For the animated version see the homepage
  // showcase.
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
</script>

<div class="flex flex-col gap-2 w-full max-w-md mx-auto">
  <UserMessageView text="How do I install tomat?" />
  <AgentMessageView kind="content" bgClass="bubble-agent">
    {#snippet body()}
      <span class="whitespace-pre-wrap break-words"
        >Run the one-line installer from the landing page, then launch the app. Want the per-OS
        steps?</span
      >
    {/snippet}
  </AgentMessageView>
</div>
