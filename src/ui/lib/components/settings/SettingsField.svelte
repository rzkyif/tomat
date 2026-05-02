<script lang="ts">
  import type { PresetOption, SettingField } from "$lib/shared/settings";
  import { evalCondition } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import CommandPreviewField from "./fields/CommandPreviewField.svelte";
  import MultilineField from "./fields/MultilineField.svelte";
  import PresetField from "./fields/PresetField.svelte";
  import ServicesField from "./fields/ServicesField.svelte";
  import ShortcutField from "./fields/ShortcutField.svelte";
  import SnippetsField from "./fields/SnippetsField.svelte";
  import StandardField from "./fields/StandardField.svelte";
  import StorageField from "./fields/StorageField.svelte";
  import ToolkitsField from "./fields/ToolkitsField.svelte";

  let { field, monitors, error, horizontal = false, onChange, onReset, onPresetSelect } = $props<{
    field: SettingField;
    monitors: Monitor[];
    error: string | null;
    horizontal?: boolean;
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
  {:else if field.type === "shortcut"}
    <ShortcutField {field} {error} {horizontal} {onChange} {onReset} />
  {:else if field.type === "toolkits"}
    <ToolkitsField {field} />
  {:else}
    <StandardField {field} {monitors} {error} {horizontal} {onChange} {onReset} />
  {/if}
{/if}
