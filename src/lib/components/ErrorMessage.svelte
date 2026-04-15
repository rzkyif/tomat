<script lang="ts">
  import Bubble from "./Bubble.svelte";
  import { settingsState } from "../state";
  import { getTextContent, type MessageContent } from "$lib/shared/types";
  import type { LLMErrorType } from "$lib/shared/types";

  let { content } = $props<{
    content: MessageContent;
  }>();

  let rawText = $derived(getTextContent(content));

  // Content format: "error_type" or "error_type\ndetail message"
  let errorType = $derived(rawText.split("\n")[0]);
  let errorDetail = $derived(
    rawText.includes("\n") ? rawText.slice(rawText.indexOf("\n") + 1) : "",
  );

  // Map error types to human-readable messages
  function getErrorMessage(errorType: LLMErrorType | string): string {
    switch (errorType) {
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
      case "unknown_error":
      default:
        return "An unexpected error occurred. Please try again.";
    }
  }

  const errorMessage = $derived(getErrorMessage(errorType));
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  bgClass="bg-accent-red-300"
  extraClass="text-default-800"
>
  {errorMessage}
  {#if errorDetail}
    <div class="error-code-wrapper">
      <div class="error-code-scroller">
        <pre><code>{errorDetail}</code></pre>
      </div>
    </div>
  {/if}
</Bubble>

<style lang="scss">
  .error-code-wrapper {
    overflow: hidden;
    border-radius: 6px;
    margin-top: 0.5rem;
    background-color: #1e1e1e;
  }
  .error-code-scroller {
    overflow-x: auto;
    overflow-y: clip;
    &::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    &::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.05);
    }
    &::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }
    &::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.3);
    }
  }
  pre {
    display: flex;
    line-height: 1.45;
    padding: 1rem;
    margin: 0;
    code {
      overflow: clip;
      font-size: 0.9em;
      font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace;
      background: transparent;
      padding: 0;
      color: white;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
</style>
