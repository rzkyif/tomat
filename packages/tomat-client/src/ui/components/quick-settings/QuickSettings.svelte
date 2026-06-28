<script lang="ts">
  // Quick settings mode: a single-open accordion of module sections. Each
  // header carries the module's on/off toggle (where one exists) and the open
  // body renders curated schema fields through the same SettingsField
  // renderer and field-change engine as the full Settings panel, so values
  // round-trip identically. Auto-opened once after the first core is paired;
  // also openable from Settings.

  import { onMount } from "svelte";
  import Bubble from "@tomat/shared/ui/components/primitives/Bubble.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import QuickSettingsView from "@tomat/shared/ui/components/quick-settings/QuickSettingsView.svelte";
  import { useUiContext } from "@tomat/shared/ui/context";
  import QuickSettingsSection from "./QuickSettingsSection.svelte";
  import { QUICK_SETTINGS_SECTIONS, type QuickSettingsSectionDef } from "./manifest";
  import { downloadsState, settingsState, viewState } from "$stores";
  import { useSettingsForm } from "$composables/use-settings-form.svelte";
  import { useResponsiveLayout } from "$composables/use-responsive-layout.svelte";

  const form = useSettingsForm();
  const layout = useResponsiveLayout();
  const ui = useUiContext();
  // On mobile the panel mounts permanently in the chat shell and presents itself
  // as a draggable Modal bottom sheet that self-gates on the view mode (rising
  // over the live chat instead of replacing it). The Modal supplies the surface,
  // padding, rounding, and slide, so the content renders bare inside it. On
  // desktop the panel is rendered by the route only while in quickSettings mode,
  // so it draws its own Bubble with no gating.
  const mobile = $derived(ui.platform === "mobile");

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

  // Single-open accordion. The general section starts open.
  let openId = $state<string | null>("general");

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
  const exitIcon = $derived(
    hasPending ? "i-material-symbols-download-rounded" : "i-material-symbols-arrow-forward-rounded",
  );

  function exit(): void {
    viewState.navigate(hasPending ? "settings" : "chat");
  }
</script>

{#if mobile}
  <Modal
    open={viewState.mode === "quickSettings"}
    onclose={exit}
    positioning="fixed"
    ariaLabel="Quick Settings"
  >
    {@render content()}
  </Modal>
{:else}
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    extraClass="flex flex-col gap-3 w-[34rem] max-w-full max-h-[80vh] overflow-hidden"
  >
    {@render content()}
  </Bubble>
{/if}

{#snippet content()}
  <QuickSettingsView
    {exitLabel}
    {exitTitle}
    {exitIcon}
    onExit={exit}
    containerRef={(el) => (layout.containerEl = el ?? undefined)}
  >
    {#snippet sections()}
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
    {/snippet}
  </QuickSettingsView>
{/snippet}
