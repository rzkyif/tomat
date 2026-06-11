<script lang="ts">
  // One Quick Settings accordion section: a header row (expand button plus an
  // optional module on/off toggle) and, while open, a vertically scrollable
  // body of schema fields rendered through SettingsField. The toggle is a
  // sibling of the expand button, not a child: nesting the Toggle's input
  // inside a <button> would be invalid HTML.

  import type { PresetOption } from "@tomat/shared";
  import { evalCondition, findField } from "@tomat/shared";
  import { settingsState } from "$lib/state";
  import SettingsField from "../settings/SettingsField.svelte";
  import Expand from "../ui/Expand.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import type { QuickSettingsSectionDef } from "./manifest";

  let {
    section,
    open,
    enabled,
    horizontal = false,
    validationErrors,
    onToggleOpen,
    onSetEnabled,
    onChange,
    onReset,
    onPresetSelect,
  } = $props<{
    section: QuickSettingsSectionDef;
    /** Body rendered. The caller derives this as `selected && enabled`, so a
     *  disabled module can never be open. */
    open: boolean;
    enabled: boolean;
    horizontal?: boolean;
    validationErrors: Record<string, string>;
    onToggleOpen: () => void;
    onSetEnabled: (value: boolean) => void;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  // The manifest is static, so an unresolved id only happens on schema drift
  // (guarded by manifest.test.ts); drop it rather than crash.
  const resolved = $derived(
    section.fields.flatMap((ref: QuickSettingsSectionDef["fields"][number]) => {
      const field = findField(ref.id);
      return field ? [{ ref, field }] : [];
    }),
  );
</script>

<!-- The open section claims the remaining panel height and scrolls inside it;
     closed sections are fixed header rows. -->
<div class="flex flex-col {open ? 'flex-1 min-h-0' : 'shrink-0'}">
  <div class="flex items-center gap-2 shrink-0">
    <button
      type="button"
      class="flex flex-1 items-center gap-2 py-2 text-default-800 cursor-pointer transition-colors hover:text-default-900 disabled:opacity-50 disabled:cursor-default"
      disabled={!enabled}
      aria-expanded={open}
      onclick={onToggleOpen}
    >
      <i
        class="flex text-xl transition-transform duration-200 {open
          ? 'i-material-symbols-keyboard-arrow-down-rounded'
          : 'i-material-symbols-chevron-right-rounded'}"
      ></i>
      <span class="flex-1 text-left text-base font-medium">{section.title}</span>
    </button>
    {#if section.enabledField}
      <Toggle
        variant="pill"
        checked={enabled}
        ariaLabel={`Enable ${section.title}`}
        onchange={onSetEnabled}
      />
    {/if}
  </div>
  <!-- pl-7 lines the field column up under the header title: chevron
       (text-xl, 1.25rem) + the header's gap-2 (0.5rem). The Expand wrapper
       doubles as the scroll container: runExpand reads its scrollHeight,
       which a scroll container reports as the full content height even while
       max-height clamps it, so the open/close sweep tracks the real size. -->
  <Expand {open} class="tomat-scroll overflow-y-auto min-h-0 flex flex-col gap-1 pl-7 pr-2 pb-1">
    {#each resolved as { ref, field } (ref.id)}
      {#if evalCondition(ref.visibleWhen, settingsState.currentSettings)}
        <SettingsField
          {field}
          monitors={[]}
          fonts={[]}
          error={validationErrors[field.id] ?? null}
          {horizontal}
          {onChange}
          {onReset}
          {onPresetSelect}
        />
      {/if}
    {/each}
  </Expand>
</div>
