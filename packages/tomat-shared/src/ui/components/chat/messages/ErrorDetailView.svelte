<script lang="ts">
  // The one standardized error display: an optional friendly message row (a red
  // icon aligned to the first line of the message) above an optional mono card
  // holding the raw technical detail. Both the message and the detail card are
  // red-accented (`bg-accent-red-200` card, red mono text, no border) so the
  // error reads the same in every context, inside a red Bubble or on a neutral
  // surface. Used by every error site (chat error bubble, tool calls, relevant
  // memories/tools, the add-a-core wizard, the core bar, and the settings
  // load-failure states) so they cannot drift. Pure: data in, no callbacks.
  let {
    message = undefined,
    detail = undefined,
    icon = "i-material-symbols-error-outline-rounded",
  }: {
    /** Friendly, plain-language failure message. Omit for a detail-only card
     *  (e.g. a tool-call bubble whose header already says it failed). */
    message?: string;
    /** Raw technical detail, shown in a scrollable mono card. */
    detail?: string;
    /** Leading icon for the message row. */
    icon?: string;
  } = $props();
</script>

<div class="flex flex-col gap-2 text-left">
  {#if message}
    <div class="flex items-start gap-1.5 text-xs text-accent-red-700">
      <span class="flex items-center shrink-0 h-4"><i class="flex {icon}"></i></span>
      <span class="min-w-0 break-words leading-4">{message}</span>
    </div>
  {/if}
  {#if detail}
    <pre
      class="tomat-scroll-inset m-0 font-mono text-xs text-accent-red-700 bg-accent-red-200 rounded-medium px-2.5 py-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{detail}</pre>
  {/if}
</div>
