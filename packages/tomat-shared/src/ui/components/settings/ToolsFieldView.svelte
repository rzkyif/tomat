<script lang="ts">
  // Presentational empty/error state for the Tools list. The list shell, cards,
  // and detail pane live in ../objects/* and ./ToolDetailView; this is only
  // ToolsField's own bespoke empty-state markup. The client owns the live tool
  // catalog and load error and passes the resolved state in: a load error, an
  // active search with no matches, or no tools at all.
  let {
    loadError = null,
    hasQuery = false,
  }: {
    loadError?: string | null;
    hasQuery?: boolean;
  } = $props();
</script>

<div class="flex flex-col items-center justify-center gap-1 py-12 text-center">
  {#if loadError}
    <div class="text-base text-accent-red-600">Couldn't load tools</div>
    <div class="text-sm text-default-500">{loadError}</div>
  {:else if hasQuery}
    <div class="text-base text-default-700">No matching tools</div>
  {:else}
    <div class="text-base text-default-700">No tools yet</div>
    <div class="text-sm text-default-500">
      Install an extension or add an MCP server to get tools.
    </div>
  {/if}
</div>
