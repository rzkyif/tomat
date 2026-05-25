<script lang="ts">
  // Quick setup mode: a hand-designed page exposing the most commonly changed
  // settings. Writes go through the same `settingsState` layer as the full
  // Settings UI, so values round-trip and the live-apply effects fire.
  // Auto-opened once after the first core is paired; also openable from
  // Settings.

  import Bubble from "../ui/Bubble.svelte";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import OptionCard from "../ui/OptionCard.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { settingsState, viewState } from "$lib/state";
  import { findField, type PresetOption } from "@tomat/shared";

  type SegOption = { value: string; label: string };

  let alignment = $derived(settingsState.getAlignment());

  // Local-model presets come straight from the settings schema so this page
  // never drifts from the full Settings UI.
  const presetField = findField("llm.preset");
  const modelPresets: PresetOption[] =
    presetField && presetField.type === "preset"
      ? presetField.presetConfig.options
      : [];

  const themeOptions: SegOption[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "auto", label: "Auto" },
  ];
  const alignmentOptions: SegOption[] = [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" },
  ];

  let theme = $derived(
    (settingsState.currentSettings["appearance.theme"] as string) ?? "auto",
  );
  let textSize = $derived(
    Number(settingsState.currentSettings["appearance.textSize"]) || 18,
  );
  let windowAlignment = $derived(
    (settingsState.currentSettings["layout.alignment"] as string) ?? "center",
  );
  let ttsEnabled = $derived(!!settingsState.currentSettings["tts.enabled"]);
  let modelPreset = $derived(settingsState.currentSettings["llm.preset"]);

  function set(key: string, value: unknown): void {
    void settingsState.updateSetting(key, value);
  }

  function changeTextSize(delta: number): void {
    set("appearance.textSize", Math.max(12, Math.min(32, textSize + delta)));
  }

  function applyModelPreset(preset: PresetOption): void {
    const updates: Record<string, unknown> = { "llm.preset": preset.id };
    if (preset.defaults) Object.assign(updates, preset.defaults);
    void settingsState.updateSettings(updates);
  }
</script>

{#snippet segmented(
  current: string,
  options: SegOption[],
  onpick: (value: string) => void,
  ariaLabel: string,
)}
  <SegmentedControl
    value={current}
    {options}
    onchange={onpick}
    {ariaLabel}
  />
{/snippet}

<Bubble
  selectedAlignment={alignment}
  extraClass="flex flex-col gap-5 w-[34rem] max-w-full"
>
  <!-- Header -->
  <div class="flex items-center gap-2">
    <i class="flex i-material-symbols-bolt-rounded text-2xl text-default-700"
    ></i>
    <h1 class="text-lg font-medium text-default-800 flex-1">Quick Setup</h1>
    <IconButton
      icon="i-material-symbols-close-rounded"
      title="Back to Chat"
      size="lg"
      variant="subtle"
      surface="circle"
      onclick={() => viewState.navigate("chat")}
    />
  </div>
  <p class="text-sm text-default-600 -mt-3">
    The essentials to get going. Everything here is also in Settings.
  </p>

  <!-- Theme -->
  <section class="flex flex-col gap-2">
    <span class="text-sm font-medium text-default-700">Theme</span>
    {@render segmented(
      theme,
      themeOptions,
      (v) => set("appearance.theme", v),
      "Theme",
    )}
  </section>

  <!-- Text size -->
  <section class="flex items-center justify-between gap-3">
    <span class="text-sm font-medium text-default-700">Text Size</span>
    <div class="flex items-center gap-2">
      <IconButton
        icon="i-material-symbols-remove-rounded"
        title="Smaller"
        size="lg"
        surface="filled"
        class="w-8 h-8 hover:bg-default-300"
        disabled={textSize <= 12}
        onclick={() => changeTextSize(-1)}
      />
      <span class="text-sm text-default-800 w-12 text-center tabular-nums">
        {textSize}px
      </span>
      <IconButton
        icon="i-material-symbols-add-rounded"
        title="Larger"
        size="lg"
        surface="filled"
        class="w-8 h-8 hover:bg-default-300"
        disabled={textSize >= 32}
        onclick={() => changeTextSize(1)}
      />
    </div>
  </section>

  <!-- Window position -->
  <section class="flex flex-col gap-2">
    <span class="text-sm font-medium text-default-700">Window Position</span>
    {@render segmented(
      windowAlignment,
      alignmentOptions,
      (v) => set("layout.alignment", v),
      "Window Position",
    )}
  </section>

  <!-- Language model -->
  {#if modelPresets.length > 0}
    <section class="flex flex-col gap-2">
      <span class="text-sm font-medium text-default-700">Language Model</span>
      <div class="flex flex-col gap-2">
        {#each modelPresets as preset (preset.id)}
          <OptionCard
            selected={modelPreset === preset.id}
            selectedStyle="accent"
            accent="blue"
            title={preset.title ?? preset.label}
            description={preset.description?.split("\n")[0] ?? ""}
            onclick={() => applyModelPreset(preset)}
          />
        {/each}
      </div>
    </section>
  {/if}

  <!-- Text-to-speech -->
  <section class="flex items-center justify-between gap-3">
    <div class="flex flex-col">
      <span class="text-sm font-medium text-default-700">
        Read responses aloud
      </span>
      <span class="text-xs text-default-500">
        Speak assistant replies as they stream.
      </span>
    </div>
    <Toggle
      variant="pill"
      checked={ttsEnabled}
      ariaLabel="Read responses aloud"
      onchange={(v) => set("tts.enabled", v)}
    />
  </section>

  <Button
    variant="primary"
    onclick={() => viewState.navigate("chat")}
    class="px-4 py-2.5 rounded-large text-accent-blue-700 hover:bg-accent-blue-300 font-medium"
  >
    Continue to chat
  </Button>
</Bubble>
