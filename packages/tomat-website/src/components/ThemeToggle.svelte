<script lang="ts">
  // Navbar chrome (not a represented app component): an icon button in the bar
  // (icon variant) styled to match the GitHub icon (lg IconButton styling), or a
  // labeled SidebarItem-style row in the mobile sidebar footer (row variant).
  // Toggles the `.dark` class the no-flash head script set, and persists the
  // choice. With JS off this control is absent and the theme follows the OS.

  let { variant = "icon" }: { variant?: "icon" | "row" } = $props();

  let dark = $state(false);

  $effect(() => {
    dark = document.documentElement.classList.contains("dark");
  });

  function toggle() {
    dark = !dark;
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("tomat-theme", dark ? "dark" : "light");
    } catch (_) {
      // private mode / storage disabled: the toggle still works for the session
    }
  }

  const icon = $derived(
    dark ? "i-material-symbols-light-mode-rounded" : "i-material-symbols-dark-mode-rounded",
  );
  const title = $derived(dark ? "Switch to light theme" : "Switch to dark theme");
</script>

{#if variant === "row"}
  <button
    type="button"
    onclick={toggle}
    {title}
    aria-label={title}
    class="flex items-center h-8 pl-1.5 pr-2.5 gap-1.5 rounded-medium text-default-500 hover:text-default-700 hover:bg-surface-inset transition-colors hover:cursor-pointer"
  >
    <i class="flex text-xl shrink-0 {icon}"></i>
    {dark ? "Light theme" : "Dark theme"}
  </button>
{:else}
  <button
    type="button"
    onclick={toggle}
    {title}
    aria-label={title}
    class="flex items-center justify-center shrink-0 p-2 text-xl text-default-700 hov:text-default-900 rounded hov:cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none"
  >
    <i class="flex {icon}"></i>
  </button>
{/if}
