<script lang="ts">
  import Bubble from "../../primitives/Bubble.svelte";
  import { useUiContext } from "../../../context.ts";

  // Presentational error bubble: maps a model/runtime error type to a friendly
  // message and shows the optional raw detail in a scrollable code block. The
  // client wrapper parses the message content into `errorType` / `errorDetail`;
  // alignment comes from the UI context so both apps match.
  const ui = useUiContext();

  let { errorType, errorDetail = "" }: { errorType: string; errorDetail?: string } = $props();

  function errorMessage(type: string): string {
    switch (type) {
      case "rate_limit_error":
        return "Rate limit exceeded. Please wait a moment and try again.";
      case "context_length_exceeded_error":
        return "Conversation is too long. Please start a new chat.";
      case "authentication_error":
        return "Authentication failed. Please check your API key.";
      case "invalid_request_error":
        return "Invalid request. Please try again.";
      case "server_error":
        return "Server error. Please try again later.";
      default:
        return "An unexpected error occurred. Please try again.";
    }
  }

  const message = $derived(errorMessage(errorType));
</script>

<Bubble selectedAlignment={ui.getAlignment()} bgClass="bg-accent-red-300" extraClass="text-default-800">
  {message}
  {#if errorDetail}
    <div class="error-code-wrapper">
      <div class="error-code-scroller tomat-scroll-dark">
        <pre><code>{errorDetail}</code></pre>
      </div>
    </div>
  {/if}
</Bubble>

<style>
  .error-code-wrapper {
    overflow: hidden;
    border-radius: 6px;
    margin-top: 0.5rem;
    background-color: var(--code-bg);
  }
  .error-code-scroller {
    overflow-x: auto;
    overflow-y: clip;
  }
  pre {
    display: flex;
    line-height: 1.45;
    padding: 1rem;
    margin: 0;
  }
  pre code {
    overflow: clip;
    font-size: 0.9em;
    font-family: var(--font-mono);
    background: transparent;
    padding: 0;
    color: white;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
