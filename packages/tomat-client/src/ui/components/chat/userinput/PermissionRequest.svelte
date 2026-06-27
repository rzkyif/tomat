<script lang="ts">
  import type { PendingPermission } from "$stores/permissions.svelte";
  import PermissionRequestView from "@tomat/shared/ui/components/chat/userinput/PermissionRequestView.svelte";

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
      case "memories":
        return p.resource === "write"
          ? { action: "create and edit your memories" }
          : { action: "read your memories" };
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

<PermissionRequestView
  toolName={request.toolName}
  action={parts.action}
  detail={parts.detail}
  declared={request.declared}
/>
