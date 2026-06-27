<script lang="ts">
  // The Quick Settings panel chrome: a header (bolt icon, title, close button)
  // with intro prose, an accordion region for the module sections, and a bottom
  // exit button. Pure: the client owns the live accordion (which sections, their
  // open/enabled state, the schema fields) and feeds it through the `sections`
  // snippet, plus a `containerRef` callback so it can observe the region for its
  // horizontal-mode threshold. This draws the surrounding shell and emits exits.
  import type { Snippet } from "svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import Button from "../primitives/Button.svelte";

  let {
    exitLabel = "Continue to Chat",
    exitTitle = "Back to Chat",
    onExit = noop,
    containerRef = noopEl,
    sections,
  }: {
    /** The bottom button's label (e.g. "Review Pending Downloads"). */
    exitLabel?: string;
    /** The close button's title/tooltip. */
    exitTitle?: string;
    onExit?: () => void;
    /** Receives the accordion region element so the client can observe it for
     *  its horizontal-mode threshold. */
    containerRef?: (el: HTMLElement | null) => void;
    sections: Snippet;
  } = $props();

  function noop(): void {}
  function noopEl(_el: HTMLElement | null): void {}

  function attachContainer(node: HTMLElement) {
    containerRef(node);
    return () => containerRef(null);
  }
</script>

<!-- Header -->
<div class="flex items-center gap-2 shrink-0">
  <i class="flex i-material-symbols-bolt-rounded text-2xl text-default-700"></i>
  <h1 class="text-lg font-medium text-default-800 flex-1">Quick Settings</h1>
  <IconButton
    icon="i-material-symbols-close-rounded"
    title={exitTitle}
    size="lg"
    variant="subtle"
    surface="circle"
    onclick={onExit}
  />
</div>
<p class="text-sm text-default-600 -mt-3 shrink-0">
  The essentials to get going. Everything here is also in Settings.
</p>

<!-- Accordion -->
<div class="flex flex-col gap-1 flex-1 min-h-0" {@attach attachContainer}>
  {@render sections()}
</div>

<Button
  variant="primary"
  onclick={onExit}
  class="shrink-0 px-4 py-2.5 rounded-large font-medium"
>
  {exitLabel}
</Button>
