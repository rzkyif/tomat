<script lang="ts">
  import type { Snippet } from "svelte";

  // One labeled frame in the component gallery: a `View · scenario` caption over
  // a centered render area. The View itself is rendered into `children` by the
  // gallery, so this stays a dumb frame.
  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<div class="flex flex-col gap-2">
  <div class="text-xs font-mono text-default-500">{label}</div>
  <div
    class="rounded-medium border border-default-200 bg-surface-inset p-6 flex items-center justify-center min-h-24"
  >
    {@render children()}
  </div>
</div>
