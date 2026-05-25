<script lang="ts">
  let {
    value = $bindable(""),
    oninput,
    onfocus,
    onclear,
    placeholder = "Search...",
    ariaLabel,
    el = $bindable<HTMLInputElement | undefined>(undefined),
    class: extraClass = "",
  }: {
    value?: string;
    oninput?: (v: string) => void;
    onfocus?: (e: FocusEvent) => void;
    /** When provided, shows a clear button next to the search icon when
     *  `value` is non-empty. The handler runs on click; the consumer is
     *  responsible for actually clearing `value`. */
    onclear?: () => void;
    placeholder?: string;
    ariaLabel?: string;
    el?: HTMLInputElement | undefined;
    class?: string;
  } = $props();
</script>

<div
  class="relative h-10 bg-default-200 rounded-large overflow-hidden w-full flex items-center px-4 pr-8 {extraClass}"
>
  <input
    bind:this={el}
    bind:value
    type="text"
    {placeholder}
    aria-label={ariaLabel}
    class="bg-transparent outline-none text-base text-default-600 w-full"
    oninput={(e) => oninput?.((e.target as HTMLInputElement).value)}
    {onfocus}
  />
  {#if value && onclear}
    <button
      class="flex absolute right-3 top-1/2 -translate-y-1/2 text-default-400 hover:text-default-600 text-lg cursor-pointer transition-colors"
      onclick={onclear}
      title="Clear search"
      aria-label="Clear search"
    >
      <i class="flex i-material-symbols-close-rounded"></i>
    </button>
  {:else}
    <i
      class="flex i-material-symbols-search-rounded absolute right-3 top-1/2 -translate-y-1/2 text-default-400 text-lg pointer-events-none"
    ></i>
  {/if}
</div>
