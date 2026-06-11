<script lang="ts">
  // Quick settings mode: a single-open accordion of module sections. Each
  // header carries the module's on/off toggle (where one exists) and the open
  // body renders curated schema fields through the same SettingsField
  // renderer and field-change engine as the full Settings panel, so values
  // round-trip identically. Auto-opened once after the first core is paired;
  // also openable from Settings.

  import { onMount } from "svelte";
  import Bubble from "../ui/Bubble.svelte";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import QuickSettingsSection from "./QuickSettingsSection.svelte";
  import { QUICK_SETTINGS_SECTIONS, type QuickSettingsSectionDef } from "./manifest";
  import { downloadsState, settingsState, viewState } from "$lib/state";
  import { useSettingsForm } from "$lib/composables/use-settings-form.svelte";
  import { useResponsiveLayout } from "$lib/composables/use-responsive-layout.svelte";

  const form = useSettingsForm();
  const layout = useResponsiveLayout();

  // Track the user's horizontal-mode threshold setting (same wiring as the
  // full Settings panel).
  $effect(() => {
    layout.threshold =
      (settingsState.currentSettings[
        "appearance.settings.horizontalThreshold"
      ] as number) ?? 680;
  });
  $effect(() => layout.observe());

  onMount(() => form.validateAllFields());

  // Single-open accordion. The language model starts open: picking a model
  // preset is the one decision that matters right after the first core is
  // paired (this view's auto-open moment).
  let openId = $state<string | null>("llm");

  function isEnabled(section: QuickSettingsSectionDef): boolean {
    return !section.enabledField ||
      !!settingsState.currentSettings[section.enabledField];
  }

  function toggleOpen(id: string): void {
    openId = openId === id ? null : id;
  }

  // Optimistic: currentSettings flips synchronously, so the body reacts at
  // once; if the flush later fails and rolls back, the `selected && enabled`
  // conjunction below collapses the section again on its own.
  function setEnabled(section: QuickSettingsSectionDef, value: boolean): void {
    if (!section.enabledField) return;
    void form.handleChange(section.enabledField, value);
    if (value) openId = section.id;
    else if (openId === section.id) openId = null;
  }

  // Both exits (close button and bottom button) go to Settings while required
  // downloads are missing, e.g. a model picked here still needs downloading;
  // Settings pops its pending-downloads modal on arrival. Otherwise back to
  // chat.
  const hasPending = $derived(downloadsState.hasPending);
  const exitLabel = $derived(
    hasPending ? "Review Pending Downloads" : "Continue to Chat",
  );
  const exitTitle = $derived(
    hasPending ? "Review Pending Downloads" : "Back to Chat",
  );

  function exit(): void {
    viewState.navigate(hasPending ? "settings" : "chat");
  }
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-3 w-[34rem] max-w-full max-h-[80vh] overflow-hidden"
>
  <!-- Header -->
  <div class="flex items-center gap-2 shrink-0">
    <i class="flex i-material-symbols-bolt-rounded text-2xl text-default-700"
    ></i>
    <h1 class="text-lg font-medium text-default-800 flex-1">Quick Settings</h1>
    <IconButton
      icon="i-material-symbols-close-rounded"
      title={exitTitle}
      size="lg"
      variant="subtle"
      surface="circle"
      onclick={exit}
    />
  </div>
  <p class="text-sm text-default-600 -mt-3 shrink-0">
    The essentials to get going. Everything here is also in Settings.
  </p>

  <!-- Accordion -->
  <div
    class="flex flex-col gap-1 flex-1 min-h-0"
    bind:this={layout.containerEl}
  >
    {#each QUICK_SETTINGS_SECTIONS as section (section.id)}
      <QuickSettingsSection
        {section}
        open={openId === section.id && isEnabled(section)}
        enabled={isEnabled(section)}
        horizontal={layout.horizontal}
        validationErrors={form.validationErrors}
        onToggleOpen={() => toggleOpen(section.id)}
        onSetEnabled={(v) => setEnabled(section, v)}
        onChange={form.handleChange}
        onReset={form.resetToDefault}
        onPresetSelect={form.handlePresetSelect}
      />
    {/each}
  </div>

  <Button
    variant="primary"
    onclick={exit}
    class="shrink-0 px-4 py-2.5 rounded-large font-medium"
  >
    {exitLabel}
  </Button>
</Bubble>
