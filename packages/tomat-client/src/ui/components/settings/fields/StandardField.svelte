<script lang="ts">
  import type { SettingField, SettingOption } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import type { Monitor } from "$lib/util/types";
  import { settingsState } from "../../../state";
  import { cores } from "$lib/core";
  import FieldCard from "./FieldCard.svelte";
  import Input from "../../ui/Input.svelte";
  import Select from "../../ui/Select.svelte";
  import Toggle from "../../ui/Toggle.svelte";

  let {
    field,
    monitors,
    fonts,
    error,
    horizontal = false,
    onChange,
    onReset,
  } = $props<{
    field: SettingField;
    monitors: Monitor[];
    fonts: string[];
    error: string | null;
    horizontal?: boolean;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  // Voices of the currently-selected TTS model (optionsSource "tts_voices"),
  // fetched from the core and refreshed whenever the model changes.
  let ttsVoices = $state<SettingOption[]>([]);
  $effect(() => {
    if (field.type !== "select" || field.optionsSource !== "tts_voices") return;
    // Re-run when the selected model changes (a preset/model switch).
    void settingsState.currentSettings["tts.modelType"];
    void settingsState.currentSettings["tts.modelPath"];
    void loadTtsVoices();
  });
  async function loadTtsVoices(): Promise<void> {
    if (!cores().currentEntry()) return;
    try {
      const voices = await cores().api().tts.voices();
      ttsVoices = voices.map((v) => ({ value: v.id, label: v.label }));
    } catch {
      ttsVoices = [];
    }
  }

  function resolveSelectOptions(): SettingOption[] {
    if (field.type !== "select") return [];
    if (field.optionsSource === "monitors") {
      return [
        { value: "primary", label: "Primary Monitor" },
        ...monitors.map((m: Monitor) => ({
          value: m.id.toString(),
          label: m.name,
        })),
      ];
    }
    if (field.optionsSource === "fonts") {
      return [
        { value: "default", label: "Default" },
        ...fonts.map((f: string) => ({ value: f, label: f })),
      ];
    }
    if (field.optionsSource === "tts_voices") return ttsVoices;
    return field.options ?? [];
  }
  const selectOptions = $derived(resolveSelectOptions());

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const hasError = $derived(!!error);

  const inputType = $derived(
    field.type === "password"
      ? "password"
      : field.type === "number" || field.type === "float"
        ? "number"
        : "text",
  );
  const isNumeric = $derived(field.type === "number" || field.type === "float");
  const numericStep = $derived(field.type === "float" ? 0.1 : 1);

  // Secret fields never receive their stored value from core. When one is
  // configured server-side and the input is empty, show a "saved" placeholder
  // so the user knows a value is set without exposing it.
  const basePlaceholder = $derived(
    "placeholder" in field ? (field.placeholder ?? "") : "",
  );
  const placeholder = $derived(
    field.type === "password" &&
      settingsState.isSecretConfigured(field.id) &&
      !settingsState.currentSettings[field.id]
      ? "•••••••••• saved"
      : basePlaceholder,
  );
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  {#if field.type === "boolean"}
    <Toggle
      checked={settingsState.currentSettings[field.id]}
      disabled={!editable}
      ariaLabel={field.name}
      onchange={(v) => onChange(field.id, v)}
    />
  {:else if field.type === "select"}
    <Select
      value={settingsState.currentSettings[field.id]}
      options={selectOptions}
      disabled={!editable}
      ariaLabel={field.name}
      onchange={(v) => onChange(field.id, v)}
    />
  {:else}
    <Input
      type={inputType}
      value={settingsState.currentSettings[field.id]}
      step={numericStep}
      spinner={isNumeric}
      {placeholder}
      disabled={!editable}
      error={hasError}
      suffix={field.suffix}
      ariaLabel={field.name}
      onchange={(v) => {
        if (isNumeric) {
          onChange(
            field.id,
            field.type === "float" ? parseFloat(v) : parseInt(v, 10),
          );
        } else {
          onChange(field.id, v);
        }
      }}
    />
  {/if}
</FieldCard>
