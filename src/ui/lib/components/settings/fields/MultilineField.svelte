<script lang="ts">
  import type { SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import { settingsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";

  let { field, error, onChange, onReset } = $props<{
    field: SettingField;
    error: string | null;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const currentValue = $derived(settingsState.currentSettings[field.id]);
  const hasError = $derived(!!error);

  // While focused, grow the textarea to its full scrollHeight so the user
  // can see all of their text. On blur, return to the limited min-h-40 box.
  let focused = $state(false);
  let textareaEl = $state<HTMLTextAreaElement>();

  function fitToContent() {
    if (!textareaEl) return;
    // Reset first so shrinking on delete works.
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }

  function onFocus() {
    focused = true;
    fitToContent();
  }

  function onBlur() {
    focused = false;
    if (textareaEl) {
      // Clear the inline height so the CSS min-h-40 rule takes over again,
      // returning the textarea to its limited resting height.
      textareaEl.style.height = "";
    }
  }

  function onInput(e: Event) {
    onChange(field.id, (e.target as HTMLTextAreaElement).value);
    if (focused) fitToContent();
  }
</script>

<FieldCard {field} {error} {onReset}>
  <textarea
    bind:this={textareaEl}
    aria-label={field.name}
    class="multiline-scroll text-default-800 rounded-medium w-full px-2 py-1.5 outline-none min-h-40 resize-y overflow-y-hidden focus:overflow-y-auto whitespace-pre-wrap break-words text-sm {field.mono
      ? 'font-mono'
      : ''} {!editable ? 'opacity-60' : ''} {hasError
      ? 'bg-accent-red-300 border-accent-red-400'
      : 'bg-default-300 focus:ring-blue-500'}"
    disabled={!editable}
    placeholder={field.placeholder || ""}
    value={currentValue}
    oninput={onInput}
    onfocus={onFocus}
    onblur={onBlur}
  ></textarea>
</FieldCard>

<style>
  .multiline-scroll::-webkit-scrollbar {
    width: 8px;
  }
  .multiline-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .multiline-scroll::-webkit-scrollbar-thumb {
    background: var(--default-200);
    border-radius: 4px;
  }
  .multiline-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-400);
  }
  :global(html.dark) .multiline-scroll::-webkit-scrollbar-thumb {
    background: var(--default-d-200);
  }
  :global(html.dark) .multiline-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-d-400);
  }
</style>
