<script lang="ts">
  import type { PresetBucket, PresetOption, SettingField } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import { modelRecommendState } from "../../../state/model-recommend.svelte";
  import { cores } from "$lib/core";
  import FieldCard from "./FieldCard.svelte";
  import OptionCard from "@tomat/shared/ui/components/primitives/OptionCard.svelte";
  import Select from "@tomat/shared/ui/components/primitives/Select.svelte";
  import HelpText from "@tomat/shared/ui/components/primitives/HelpText.svelte";
  import Alert from "@tomat/shared/ui/components/primitives/Alert.svelte";

  // The adaptive LLM preset picker. Unlike the generic PresetField, each card's
  // model + tuning is computed by the core for this device; selecting a card
  // calls the select API rather than applying static defaults.
  let { field, onPresetSelect } = $props<{
    field: SettingField;
    onPresetSelect: (fieldId: string, option: PresetOption) => void;
  }>();

  const rs = modelRecommendState;

  // The dropdown value when the current llm.* config matches no catalog model.
  const MANUAL = "__manual__";

  // Load recommendations + catalog once the core is paired (and not already
  // loaded). The catalog backs the Custom card's model + quant dropdowns.
  $effect(() => {
    if (cores().currentEntry()) {
      if (!rs.recommendations && !rs.loading) void rs.load();
      if (!rs.catalog) void rs.loadCatalog();
    }
  });

  const bucketOptions = $derived(
    (field.presetConfig?.options ?? []) as PresetOption[],
  );
  const customOption = $derived(
    (field.presetConfig?.secondaryOptions ?? [])[0] as PresetOption | undefined,
  );

  function gb(bytes: number): string {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }

  function bucketRec(id: string) {
    return rs.recommendations?.buckets[id as PresetBucket] ?? null;
  }

  // --- recheck button states ----------------------------------------------
  const checkLabel = $derived(
    rs.checking
      ? "Checking…"
      : rs.checkResult === "found"
        ? "Newer Models Found"
        : rs.checkResult === "none"
          ? "No Newer Models Found"
          : "Check for Newer Models",
  );
  const checkIcon = $derived(
    rs.checking
      ? "i-line-md:loading-loop"
      : rs.checkResult === "found"
        ? "i-material-symbols-auto-awesome-rounded"
        : rs.checkResult === "none"
          ? "i-material-symbols-check-rounded"
          : "i-material-symbols-refresh-rounded",
  );

  // --- manual model + quantization dropdowns ------------------------------

  // Model dropdown: every catalog model plus "Manual Configuration". Size is a
  // range across the model's quants (the exact size is picked in the quant
  // dropdown). A model that won't fit this device is shown but disabled.
  const modelOptions = $derived([
    ...(rs.catalog ?? []).map((m) => {
      const sizes = m.quants.map((q) => q.footprintBytes / 1e9);
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      const range = min === max ? `${min.toFixed(1)} GB` : `${min.toFixed(1)}-${max.toFixed(1)} GB`;
      return {
        value: m.id,
        label: `${m.name} · ${range}${m.fits ? "" : " · won't fit"}`,
        disabled: !m.fits,
      };
    }),
    { value: MANUAL, label: "Manual Configuration" },
  ]);

  // The model dropdown reflects whichever catalog model the current llm.modelPath
  // points at; if the user has hand-edited the config to a model not in the
  // catalog, it falls back to "Manual Configuration".
  const selectedModelView = $derived(
    (rs.catalog ?? []).find((m) =>
      m.quants.some((q) => q.modelSpec === settingsState.currentSettings["llm.modelPath"])
    ) ?? null,
  );

  // Explicit "Manual Configuration" choice. Picking it doesn't change the model
  // path (a catalog model may still be configured), so it can't be derived from
  // the path alone; track it, and clear it whenever the path actually changes
  // (a bucket applied, or another model picked).
  let manualSelected = $state(false);
  let lastModelPath: string | undefined = undefined;
  $effect(() => {
    const path = settingsState.currentSettings["llm.modelPath"] as string | undefined;
    if (path !== lastModelPath) {
      lastModelPath = path;
      manualSelected = false;
    }
  });

  const selectedModel = $derived(manualSelected ? MANUAL : (selectedModelView?.id ?? MANUAL));

  // Quantization dropdown for the selected model. The fit engine flags one as
  // "recommended" (the quality/size sweet spot, capped below Q8's diminishing
  // returns); oversized quants are shown but disabled.
  const quantOptions = $derived(
    (selectedModelView?.quants ?? []).map((q) => ({
      value: q.modelSpec,
      label: `${q.quant}${q.variantLabel !== "standard" ? ` (${q.variantLabel})` : ""}` +
        ` · ${gb(q.footprintBytes)}${q.recommended ? " · recommended" : ""}${q.fits ? "" : " · won't fit"}`,
      disabled: !q.fits,
    })),
  );
  const selectedQuant = $derived(settingsState.currentSettings["llm.modelPath"] as string);

  function onModelSelect(value: string): void {
    if (value === MANUAL) {
      // Switch to Custom without touching the llama-server fields, and hide the
      // quant dropdown until a concrete model is chosen again.
      manualSelected = true;
      if (customOption) onPresetSelect(field.id, customOption);
      return;
    }
    manualSelected = false;
    void rs.applyModel(value);
  }

  function onQuantSelect(modelSpec: string): void {
    void rs.applyQuant(modelSpec);
  }
</script>

<FieldCard {field}>
  <div class="flex flex-col gap-2">
    {#if rs.error}
      <Alert variant="error" size="sm">{rs.error}</Alert>
    {/if}

    <button
      type="button"
      class="flex items-center gap-1 px-3 py-2 rounded-large bg-surface-inset text-xs text-default-600 hover:text-default-800 cursor-pointer outline-none"
      onclick={() => !rs.checking && rs.recheck()}
      aria-label="Check for newer models"
    >
      <i class="{checkIcon} text-sm"></i>
      <span>{checkLabel}</span>
    </button>

    {#each bucketOptions as opt}
      {@const bucket = opt.id as PresetBucket}
      {@const rec = bucketRec(opt.id)}
      {@const selected = settingsState.currentSettings[field.id] === opt.id}
      {@const better = rs.betterAvailable(bucket)}
      {#snippet badges()}
        {#if rec}
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-psychology-alt-rounded text-sm"></i>
            <span>{rec.name}</span>
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-memory-rounded text-sm"></i>
            <span>{gb(rec.footprintBytes)}</span>
          </span>
          <span class="inline-flex items-center gap-1">
            <i class="i-material-symbols-bolt-rounded text-sm"></i>
            <span>{rec.quant}</span>
          </span>
        {:else if rs.loading}
          <span class="opacity-60">Computing for your device…</span>
        {:else}
          <span class="opacity-60">No model fits this tier</span>
        {/if}
      {/snippet}
      <OptionCard
        {selected}
        title={opt.title ?? opt.label}
        description={opt.description}
        badges={badges}
        ariaLabel={opt.title}
        onclick={() => rec && rs.applyBucket(bucket)}
      />
      {#if better}
        <Alert
          variant="info"
          size="sm"
          action={{
            icon: rs.applying === bucket ? "i-line-md:loading-loop" : "i-material-symbols-check-rounded",
            title: "Apply",
            onclick: () => rs.applyBucket(bucket),
          }}
          onclose={() => rs.dismiss(bucket)}
        >
          A better model is available for {opt.title ?? opt.label}: {rec?.name}
        </Alert>
      {/if}
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
