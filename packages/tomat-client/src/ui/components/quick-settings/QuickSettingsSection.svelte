<script lang="ts">
  // One Quick Settings accordion section: thin client wrapper around
  // QuickSettingsSectionView. The View owns the header chrome (expand button,
  // chevron, optional on/off toggle) and the Expand scroll body; the client
  // resolves the curated schema fields and feeds them as the body snippet,
  // rendered through SettingsField so values round-trip like the full panel.
  import type { PresetOption } from "@tomat/shared";
  import { evalCondition, findField } from "@tomat/shared";
  import { settingsState } from "$stores";
  import SettingsField from "../settings/SettingsField.svelte";
  import QuickSettingsSectionView from "@tomat/shared/ui/components/quick-settings/QuickSettingsSectionView.svelte";
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

<QuickSettingsSectionView
  title={section.title}
  {open}
  {enabled}
  hasToggle={!!section.enabledField}
  onToggleExpand={onToggleOpen}
  {onSetEnabled}
>
  {#snippet body()}
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
  {/snippet}
</QuickSettingsSectionView>
