<script lang="ts">
  import type { PresetOption, SettingField, TtsCatalogModel } from "@tomat/shared";
  import { primaryFileSpec, TTS_PRIMARY_ROLE } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import { ttsModelsState } from "../../../state/tts-models.svelte";
  import { cores } from "$lib/core";
  import FieldCard from "./FieldCard.svelte";
  import OptionCard from "../../ui/OptionCard.svelte";
  import Select from "../../ui/Select.svelte";
  import HelpText from "../../ui/HelpText.svelte";
  import Alert from "../../ui/Alert.svelte";

  // The Text-to-Speech catalog picker. Mirrors SttPresetField: each card binds to
  // a catalog model and selecting one calls the select API; there is no fit
  // engine (TTS bundles are small and fit everywhere).
  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const ts = ttsModelsState;

  const MANUAL = "__manual__";

  $effect(() => {
    if (cores().currentEntry() && !ts.catalog && !ts.loading) void ts.load();
  });

  const cardOptions = $derived((field.presetConfig?.options ?? []) as PresetOption[]);
  const customOption = $derived(
    (field.presetConfig?.secondaryOptions ?? [])[0] as PresetOption | undefined,
  );

  function size(bytes: number): string {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }

  function voiceCount(n: number): string {
    return n === 1 ? "1 voice" : `${n} voices`;
  }

  function cardPreset(id: string) {
    return ts.catalog?.presets.find((p) => p.id === id) ?? null;
  }

  // --- manual model + quantization dropdowns ------------------------------

  const modelOptions = $derived([
    ...(ts.catalog?.models ?? []).map((m: TtsCatalogModel) => {
      const sizes = m.quants.map((q) => q.fileSizeBytes);
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      const range = min === max ? size(min) : `${size(min)}-${size(max)}`;
      return { value: m.id, label: `${m.name} · ${range}` };
    }),
    { value: MANUAL, label: "Manual Configuration" },
  ]);

  const selectedModelView = $derived(
    (ts.catalog?.models ?? []).find((m: TtsCatalogModel) =>
      m.quants.some(
        (q) =>
          primaryFileSpec(q, TTS_PRIMARY_ROLE[m.family]) ===
            settingsState.currentSettings["tts.modelPath"],
      )
    ) ?? null,
  );

  let manualSelected = $state(false);
  let lastModelPath: string | undefined = undefined;
  $effect(() => {
    const path = settingsState.currentSettings["tts.modelPath"] as string | undefined;
    if (path !== lastModelPath) {
      lastModelPath = path;
      manualSelected = false;
    }
  });

  const selectedModel = $derived(manualSelected ? MANUAL : (selectedModelView?.id ?? MANUAL));

  const quantOptions = $derived(
    (selectedModelView?.quants ?? []).map((q) => ({
      value: selectedModelView ? primaryFileSpec(q, TTS_PRIMARY_ROLE[selectedModelView.family]) : "",
      label: `${q.quant} · ${size(q.fileSizeBytes)}`,
    })),
  );
  const selectedQuant = $derived(settingsState.currentSettings["tts.modelPath"] as string);

  function onModelSelect(value: string): void {
    if (value === MANUAL) {
      manualSelected = true;
      if (customOption) onPresetSelect(field.id, customOption);
      return;
    }
    manualSelected = false;
    void ts.applyModel(value);
  }

  function onQuantSelect(modelSpec: string): void {
    void ts.applyQuant(modelSpec);
  }
</script>

<FieldCard {field}>
  <div class="flex flex-col gap-2">
    {#if ts.error}
      <Alert variant="error" size="sm">{ts.error}</Alert>
    {/if}

    {#each cardOptions as opt}
      {@const preset = cardPreset(opt.id)}
      {@const selected = settingsState.currentSettings[field.id] === opt.id}
      {#snippet badges()}
        {#if preset}
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-graphic-eq-rounded text-sm"></i>
            <span>{preset.name}</span>
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-memory-rounded text-sm"></i>
            <span>{size(preset.fileSizeBytes)}</span>
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-record-voice-over-rounded text-sm"></i>
            <span>{voiceCount(preset.voices.length)}</span>
          </span>
        {:else if ts.loading}
          <span class="opacity-60">Loading catalog…</span>
        {/if}
      {/snippet}
      <OptionCard
        {selected}
        title={opt.title ?? opt.label}
        description={opt.description}
        badges={badges}
        ariaLabel={opt.title}
        onclick={() => preset && ts.applyPreset(opt.id)}
      />
    {/each}

    {#if customOption}
      {@const isCustom = settingsState.currentSettings[field.id] === customOption.id}
      {@const labelClass = isCustom ? "text-default-inverted-600" : "text-default-600"}
      <div
        class="flex flex-col gap-2 p-3 rounded-large {isCustom
          ? 'bg-default-inverted-300 text-default-inverted-800'
          : 'bg-surface-inset text-default-800'}"
      >
        <button
          type="button"
          class="text-left flex flex-col gap-1.5 cursor-pointer outline-none"
          onclick={() => onPresetSelect(field.id, customOption)}
        >
          <span class="text-base font-semibold leading-tight">
            {customOption.title ?? customOption.label}
          </span>
          {#if customOption.description}
            <HelpText
              text={customOption.description}
              variant="compact"
              class={isCustom ? "text-default-inverted-500" : "text-default-500"}
            />
          {/if}
        </button>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium {labelClass}">Model</span>
          <Select
            value={selectedModel}
            options={modelOptions}
            onchange={onModelSelect}
            ariaLabel="Choose a model"
          />
        </div>
        {#if !manualSelected && selectedModelView}
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium {labelClass}">Quantization</span>
            <Select
              value={selectedQuant}
              options={quantOptions}
              onchange={onQuantSelect}
              ariaLabel="Choose a quantization"
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>
</FieldCard>
