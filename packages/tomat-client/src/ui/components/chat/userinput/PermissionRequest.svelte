<script lang="ts">
  import type { PendingPermission } from "$stores/permissions.svelte";

  let { request }: { request: PendingPermission } = $props();

  // The request as a plain-language action ("run a program") plus the concrete
  // target (the command, path, host, ...) shown on its own in a mono card, so
  // the sentence reads cleanly and the exact value is easy to scan.
  function permissionParts(
    p: PendingPermission,
  ): { action: string; detail?: string } {
    switch (p.permissionKind) {
      case "net":
        return { action: "connect to a server", detail: p.resource };
      case "read":
        return { action: "read a file", detail: p.resource };
      case "write":
        return { action: "write to a file", detail: p.resource };
      case "run":
        return { action: "run a program", detail: p.resource };
      case "env":
        return p.resource
          ? { action: "read an environment variable", detail: p.resource }
          : { action: "read all environment variables" };
      case "ffi":
        return p.resource
          ? { action: "load a native library", detail: p.resource }
          : { action: "load native libraries" };
      case "sys":
        return { action: "read system information", detail: p.resource || undefined };
      case "documents":
        return p.resource === "write"
          ? { action: "create and edit your documents" }
          : { action: "read your documents" };
      case "llm":
        return { action: "generate text with the model" };
      case "tts":
        return { action: "speak text aloud" };
      case "stt":
        return { action: "transcribe audio to text" };
    }
  }

  let parts = $derived(permissionParts(request));
</script>

<div class="flex flex-col gap-2 min-w-0 max-w-[calc(100vw-135px)] text-sm">
  <div class="flex items-center gap-2 text-default-800 font-medium">
    <i class="flex i-material-symbols-shield-question-outline-rounded text-accent-yellow-500 text-base shrink-0"></i>
    <span class="break-words">
      The <code class="font-mono bg-surface-inset rounded-small px-1.5 py-0.5">{request.toolName}</code>
      tool wants to {parts.action}.
    </span>
  </div>
  {#if parts.detail}
    <div class="font-mono text-xs bg-surface-inset text-default-800 rounded-medium px-2.5 py-2 break-all">
      {parts.detail}
    </div>
  {/if}
  {#if !request.declared}
    <span class="text-accent-yellow-600 break-words">
      This access was not declared by the Toolkit. Only allow it if you trust this Toolkit and
      the request makes sense for what you asked.
    </span>
  {/if}
</div>
