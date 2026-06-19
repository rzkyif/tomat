<script lang="ts">
  import type { SettingDestination } from "../../../domain/settings/types.ts";

  // A small uppercase chip telling the user where a setting is stored: on the
  // paired core or on the local client. Used on group headers (one per group
  // destination) and on section headers in hybrid groups (one per section).
  let { dest }: { dest: SettingDestination } = $props();
</script>

<span
  class="text-[10px] font-medium uppercase tracking-wider px-1.5 inline-flex items-center h-4 leading-none rounded-medium bg-surface-inset text-default-700"
  title={dest === "core"
    ? "Stored on the paired core (~/.tomat/core/settings.json)"
    : "Stored on this device (~/.tomat/client/settings.json)"}
>
  {dest === "core" ? "Core" : "Client"}
</span>
