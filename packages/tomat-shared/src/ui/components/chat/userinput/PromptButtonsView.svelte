<script lang="ts">
  // Presentational decline/accept button pair shown to the right of the composer
  // controls while a tool call is paused on a prompt (a permission request or a
  // schedule-confirm form). Each button is an icon + label on the filled inset
  // surface, neutral text like the other UserInput buttons, at the h-9 height of
  // the pill beside them. The client maps the active prompt to the two button
  // descriptors and their handlers, so this stays pure: data in, callbacks out.

  type PromptButton = {
    icon: string;
    label: string;
    title: string;
    disabled?: boolean;
    onClick: () => void;
  };

  let {
    buttons,
  }: {
    buttons: PromptButton[];
  } = $props();
</script>

{#each buttons as button (button.label)}
  <button
    type="button"
    title={button.title}
    disabled={button.disabled}
    class="flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-large bg-surface-inset text-sm font-medium text-default-700 hover:text-default-900 hover:cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    onclick={() => button.onClick()}
  >
    <i class="flex {button.icon} text-lg shrink-0"></i>
    {button.label}
  </button>
{/each}
