<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";
  import Slider from "../../ui/Slider.svelte";

  let {
    field,
    error,
    horizontal = false,
    onChange,
    onReset,
  } = $props<{
    field: SettingField;
    error: string | null;
    horizontal?: boolean;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const hasError = $derived(!!error);

  const min = $derived(field.min ?? 0);
  const max = $derived(field.max ?? 100);
  const step = $derived(field.step ?? 1);

  const value = $derived(
    Number(settingsState.currentSettings[field.id] ?? field.defaultValue ?? 0),
  );
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  <Slider
    {value}
    {min}
    {max}
    {step}
    pairedInput
    suffix={field.suffix}
    disabled={!editable}
    error={hasError}
    ariaLabel={field.name}
    onchange={(v) => onChange(field.id, v)}
  />
</FieldCard>
