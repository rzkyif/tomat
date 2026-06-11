<script lang="ts">
  import type { PresetOption, SettingField, SttCatalogModel } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import { sttModelsState } from "../../../state/stt-models.svelte";
  import { cores } from "$lib/core";
  import FieldCard from "./FieldCard.svelte";
  import OptionCard from "../../ui/OptionCard.svelte";
  import Select from "../../ui/Select.svelte";
  import HelpText from "../../ui/HelpText.svelte";
  import Alert from "../../ui/Alert.svelte";

  // The Speech-to-Text catalog picker. Like ModelPresetField, each card binds
  // to a catalog model and selecting one calls the select API; unlike it there
  // is no fit engine (whisper models fit everywhere), so no buckets or recheck.
  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const ss = sttModelsState;

  // The dropdown value when the current stt.modelPath matches no catalog model.
  const MANUAL = "__manual__";

  // Load the catalog once the core is paired (and not already loaded). It backs
  // both the card badges and the Custom card's model + quant dropdowns.
  $effect(() => {
    if (cores().currentEntry() && !ss.catalog && !ss.loading) void ss.load();
  });

  const cardOptions = $derived((field.presetConfig?.options ?? []) as PresetOption[]);
  const customOption = $derived(
    (field.presetConfig?.secondaryOptions ?? [])[0] as PresetOption | undefined,
  );

  // Whisper spans 31 MB to 3.1 GB, so GB-only formatting would render "0.0 GB".
  function size(bytes: number): string {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }

  function language(english: boolean): string {
    return english ? "English only" : "Multilingual";
  }

  function cardPreset(id: string) {
    return ss.catalog?.presets.find((p) => p.id === id) ?? null;
  }

  // --- manual model + quantization dropdowns ------------------------------

  // Model dropdown: every catalog model plus "Manual Configuration". Size is a
  // range across the model's quants (the exact size is picked in the quant
  // dropdown).
  const modelOptions = $derived([
    ...(ss.catalog?.models ?? []).map((m: SttCatalogModel) => {
      const sizes = m.quants.map((q) => q.fileSizeBytes);
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      const range = min === max ? size(min) : `${size(min)}-${size(max)}`;
      return {
        value: m.id,
        label: `${m.name} · ${language(m.english)} · ${range}`,
      };
    }),
    { value: MANUAL, label: "Manual Configuration" },
  ]);

  // The model dropdown reflects whichever catalog model the current
  // stt.modelPath points at; a hand-edited path not in the catalog falls back
  // to "Manual Configuration".
  const selectedModelView = $derived(
    (ss.catalog?.models ?? []).find((m: SttCatalogModel) =>
      m.quants.some((q) => q.modelSpec === settingsState.currentSettings["stt.modelPath"])
    ) ?? null,
  );

  // Explicit "Manual Configuration" choice. Picking it doesn't change the model
  // path (a catalog model may still be configured), so it can't be derived from
  // the path alone; track it, and clear it whenever the path actually changes
  // (a card applied, or another model picked).
  let manualSelected = $state(false);
  let lastModelPath: string | undefined = undefined;
  $effect(() => {
    const path = settingsState.currentSettings["stt.modelPath"] as string | undefined;
    if (path !== lastModelPath) {
      lastModelPath = path;
      manualSelected = false;
    }
  });

  const selectedModel = $derived(manualSelected ? MANUAL : (selectedModelView?.id ?? MANUAL));

  const quantOptions = $derived(
    (selectedModelView?.quants ?? []).map((q) => ({
      value: q.modelSpec,
      label: `${q.quant} · ${size(q.fileSizeBytes)}`,
    })),
  );
  const selectedQuant = $derived(settingsState.currentSettings["stt.modelPath"] as string);

  function onModelSelect(value: string): void {
    if (value === MANUAL) {
      // Switch to Custom without touching the whisper-server fields, and hide
      // the quant dropdown until a concrete model is chosen again.
      manualSelected = true;
      if (customOption) onPresetSelect(field.id, customOption);
      return;
    }
    manualSelected = false;
    void ss.applyModel(value);
  }

  function onQuantSelect(modelSpec: string): void {
    void ss.applyQuant(modelSpec);
  }
</script>

<FieldCard {field}>
  <div class="flex flex-col gap-2">
    {#if ss.error}
      <Alert variant="error" size="sm">{ss.error}</Alert>
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
            <i class="i-material-symbols-language text-sm"></i>
            <span>{language(preset.english)}</span>
          </span>
        {:else if ss.loading}
          <span class="opacity-60">Loading catalog…</span>
        {/if}
      {/snippet}
      <OptionCard
        {selected}
        title={opt.title ?? opt.label}
        description={opt.description}
        badges={badges}
        ariaLabel={opt.title}
        onclick={() => preset && ss.applyPreset(opt.id)}
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
