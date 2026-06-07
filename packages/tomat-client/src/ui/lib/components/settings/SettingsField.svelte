<script lang="ts">
  import type { PresetOption, SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import type { Monitor } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import ColorField from "./fields/ColorField.svelte";
  import CommandPreviewField from "./fields/CommandPreviewField.svelte";
  import MultilineField from "./fields/MultilineField.svelte";
  import NumberSliderField from "./fields/NumberSliderField.svelte";
  import PresetField from "./fields/PresetField.svelte";
  import ServicesField from "./fields/ServicesField.svelte";
  import ShortcutField from "./fields/ShortcutField.svelte";
  import SnippetsField from "./fields/SnippetsField.svelte";
  import ToolkitsField from "./fields/ToolkitsField.svelte";
  import CoresField from "./fields/CoresField.svelte";
  import StandardField from "./fields/StandardField.svelte";
  import StorageField from "./fields/StorageField.svelte";

  let { field, monitors, fonts, error, horizontal = false, onChange, onReset, onPresetSelect } = $props<{
    field: SettingField;
    monitors: Monitor[];
    fonts: string[];
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
    <ServicesField {field} scope={field.scope} {horizontal} />
  {:else if field.type === "storage"}
    <StorageField {field} scope={field.scope} />
  {:else if field.type === "shortcut"}
    <ShortcutField {field} {error} {horizontal} {onChange} {onReset} />
  {:else if field.type === "object_management"}
    {#if field.objectType === "snippets"}
      <SnippetsField />
    {:else if field.objectType === "toolkits"}
      <ToolkitsField />
    {:else if field.objectType === "cores"}
      <CoresField />
    {/if}
  {:else if field.type === "color"}
    <ColorField {field} {error} {horizontal} {onChange} {onReset} />
  {:else if field.type === "number_slider"}
    <NumberSliderField {field} {error} {horizontal} {onChange} {onReset} />
  {:else}
    <StandardField {field} {monitors} {fonts} {error} {horizontal} {onChange} {onReset} />
  {/if}
{/if}
