<script lang="ts">
  import SidebarItem from "@tomat/shared/ui/components/primitives/SidebarItem.svelte";
  import CollapsibleLabel from "@tomat/shared/ui/components/primitives/CollapsibleLabel.svelte";

  // The settings sidebar footer the app pins to the bottom of every settings
  // panel: a Downloads row, then the "tomat Client vX.Y.Z" version row (its
  // tomat-mark mask + a collapsing label). Server-status chips only show on
  // error/loading, so a healthy default renders none. This is the SINGLE static
  // copy the website uses everywhere it renders the settings UI (the manual demos
  // and the homepage showcase), so the footer cannot be present in one rendition
  // and missing from another. The boolean mirrors the sidebar's collapsed state,
  // so rows collapse to icons with it.
  // `pending` and `downloading` mirror the client's DownloadsButton states:
  // pending shows a "Pending Downloads" label with an accent-yellow ping (files
  // await approval); downloading shows the self-animating loop icon, a
  // "Downloading..." label, and a neutral ping. The ping is driven by `blink`,
  // which the host toggles. Both off by default so every other settings demo
  // shows the idle Downloads row.
  const noop = (): void => {};
  let {
    collapsed = false,
    pending = false,
    downloading = false,
    blink = false,
  }: {
    collapsed?: boolean;
    pending?: boolean;
    downloading?: boolean;
    blink?: boolean;
  } = $props();

  const label = $derived(
    pending ? "Pending Downloads" : downloading ? "Downloading..." : "Downloads",
  );
  const icon = $derived(
    downloading ? "i-line-md-downloading-loop" : "i-material-symbols-downloading-rounded",
  );
</script>

<SidebarItem
  {icon}
  {label}
  {collapsed}
  ping={(pending || downloading) && blink}
  pingTone={pending ? "accent" : "default"}
  title={collapsed ? label : undefined}
  ariaLabel={label}
  onclick={noop}
/>
<button
  type="button"
  class="flex items-center h-8 pl-1.5 {collapsed
    ? 'pr-0'
    : 'pr-2.5'} gap-1.5 rounded-medium text-default-500 hov:text-default-700 hov:bg-surface-inset [transition:color_500ms,background-color_200ms,padding_200ms]"
  title={collapsed ? "tomat Client" : undefined}
  aria-label="tomat Client version"
>
  <span class="relative flex shrink-0">
    <span
      class="w-5 h-5 bg-current shrink-0"
      style="mask:url(/logo.svg) center/contain no-repeat;-webkit-mask:url(/logo.svg) center/contain no-repeat;"
      aria-hidden="true"
    ></span>
  </span>
  <CollapsibleLabel {collapsed} class="text-base text-left">tomat Client v0.1.0</CollapsibleLabel>
</button>
