<script lang="ts">
  import SidebarItem from "@tomat/shared/ui/components/primitives/SidebarItem.svelte";
  import CollapsibleLabel from "@tomat/shared/ui/components/primitives/CollapsibleLabel.svelte";

  // The settings sidebar footer the app pins to the bottom of every settings
  // panel: a Downloads row, then the "tomat client vX.Y.Z" version row (its
  // tomat-mark mask + a collapsing label). Server-status chips only show on
  // error/loading, so a healthy default renders none. This is the SINGLE static
  // copy the website uses everywhere it renders the settings UI (the manual demos
  // and the homepage showcase), so the footer cannot be present in one rendition
  // and missing from another. The boolean mirrors the sidebar's collapsed state,
  // so rows collapse to icons with it.
  const noop = (): void => {};
  let { collapsed = false }: { collapsed?: boolean } = $props();
</script>

<SidebarItem
  icon="i-material-symbols-downloading-rounded"
  label="Downloads"
  {collapsed}
  title={collapsed ? "Downloads" : undefined}
  ariaLabel="Downloads"
  onclick={noop}
/>
<button
  type="button"
  class="flex items-center h-8 pl-1.5 {collapsed ? 'pr-0' : 'pr-2.5'} gap-1.5 rounded-medium text-default-500 hov:text-default-700 hov:bg-surface-inset [transition:color_500ms,background-color_200ms,padding_200ms]"
  title={collapsed ? "tomat client" : undefined}
  aria-label="tomat client version"
>
  <span class="relative flex shrink-0">
    <span
      class="w-5 h-5 bg-current shrink-0"
      style="mask:url(/logo.svg) center/contain no-repeat;-webkit-mask:url(/logo.svg) center/contain no-repeat;"
      aria-hidden="true"
    ></span>
  </span>
  <CollapsibleLabel {collapsed} class="text-base text-left">tomat client v0.1.0</CollapsibleLabel>
</button>
