<script lang="ts">
  // Presentational description of a runtime permission request: a shield line
  // ("The X tool wants to ..."), an optional mono card with the concrete target
  // (command, path, host, ...), and an optional warning when the access was not
  // declared by the Extension. The client maps the permission kind to the
  // plain-language action and target, so this stays pure: data in, no callbacks.

  let {
    toolName,
    action,
    detail,
    declared,
  }: {
    toolName: string;
    action: string;
    detail?: string;
    declared: boolean;
  } = $props();
</script>

<div class="flex flex-col gap-2 min-w-0 max-w-[calc(100vw-135px)] text-sm">
  <div class="flex items-center gap-2 text-default-800 font-medium">
    <i class="flex i-material-symbols-shield-question-outline-rounded text-accent-yellow-500 text-base shrink-0"></i>
    <span class="break-words">
      The <code class="font-mono bg-surface-inset rounded-small px-1.5 py-0.5">{toolName}</code>
      tool wants to {action}.
    </span>
  </div>
  {#if detail}
    <div class="font-mono text-xs bg-surface-inset text-default-800 rounded-medium px-2.5 py-2 break-all">
      {detail}
    </div>
  {/if}
  {#if !declared}
    <span class="text-accent-yellow-600 break-words">
      This access was not declared by the Extension. Only allow it if you trust this Extension and
      the request makes sense for what you asked.
    </span>
  {/if}
</div>
