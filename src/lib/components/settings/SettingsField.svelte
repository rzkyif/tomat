<script lang="ts">
  import type { PresetOption, SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import CommandPreviewField from "./CommandPreviewField.svelte";
  import MultilineField from "./MultilineField.svelte";
  import PresetField from "./PresetField.svelte";
  import ServicesField from "./ServicesField.svelte";
  import SnippetsField from "./SnippetsField.svelte";
  import StandardField from "./StandardField.svelte";
  import StorageField from "./StorageField.svelte";

  let { field, monitors, error, onChange, onReset, onPresetSelect } = $props<{
    field: SettingField;
    monitors: Monitor[];
    error: string | null;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const visible = $derived(evalCondition(field.visibleWhen, settingsState.currentSettings));
</script>

{#if visible}
  {#if field.type === "preset"}
    <PresetField {field} {onPresetSelect} />
  {:else if field.type === "command_preview"}
    <CommandPreviewField {field} />
  {:else if field.type === "multiline"}
    <MultilineField {field} {error} {onChange} {onReset} />
  {:else if field.type === "services"}
    <ServicesField {field} />
  {:else if field.type === "storage"}
    <StorageField {field} />
  {:else if field.type === "snippets"}
    <SnippetsField {field} />
  {:else}
    <StandardField {field} {monitors} {error} {onChange} {onReset} />
  {/if}
{/if}
