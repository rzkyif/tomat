<script lang="ts">
  import type { ComponentProps } from "svelte";
  // The mobile half of the gallery: the same shared Views and primitives the
  // desktop section renders, but under a mobile UiContext so their touch
  // branches paint (bottom-sheet modals, the stacked settings nav, the
  // keyboard-anchored autocomplete, the fullscreen chat shell). Lives in its own
  // component because setUiContext applies to the whole subtree: the desktop
  // gallery must stay on DEFAULT_UI_CONTEXT, so the mobile provider is scoped
  // here rather than mounted in Gallery.svelte. Each card sits in a phone-sized
  // frame that doubles as the containing block for the sheets' fixed/absolute
  // layers, so they pin to the frame instead of the page.
  import { getDefaultSettings } from "@tomat/shared/domain/settings/engine";
  import { makeUiContext, setUiContext } from "@tomat/shared/ui/context";
  import { SAMPLE_VALUES, SAMPLES } from "@tomat/shared/ui/samples";
  import ChatShellView from "@tomat/shared/ui/components/chat/ChatShellView.svelte";
  import SnippetAutocompleteView from "@tomat/shared/ui/components/chat/SnippetAutocompleteView.svelte";
  import SettingsShellView from "@tomat/shared/ui/components/settings/SettingsShellView.svelte";
  import SettingsContentView from "@tomat/shared/ui/components/settings/SettingsContentView.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import ActionSheet from "@tomat/shared/ui/components/primitives/ActionSheet.svelte";
  import { SETTINGS_SCHEMA } from "@tomat/shared/domain/settings/engine";
  import SettingsDemoFooter from "../demos/SettingsDemoFooter.svelte";
  import GalleryCard from "./GalleryCard.svelte";

  const noop = (): void => {};
  const D = getDefaultSettings();

  // The touch shell: compact density, coarse pointer. Schema defaults otherwise,
  // exactly like the client at default settings on a phone.
  setUiContext(
    makeUiContext({
      getSetting: (key) => D[key],
      platform: "mobile",
      density: "compact",
      pointer: "coarse",
    }),
  );

  const entries = <T,>(o: Record<string, T>) => Object.entries(o);

  function expandedFor(gid: string | undefined): Set<string> {
    const keys = new Set<string>();
    if (gid) {
      SETTINGS_SCHEMA.find((g) => g.id === gid)?.sections.forEach((s, i) => {
        if (s.label && !s.defaultCollapsed) keys.add(`${gid}-${i}`);
      });
    }
    return keys;
  }
</script>

<section class="flex flex-col gap-6">
  <h2 class="text-lg font-medium">Mobile</h2>
  <p class="text-default-500 text-sm">
    The same shared components under a mobile UiContext, framed in a phone-sized
    viewport so their touch branches (bottom sheets, stacked settings, the
    fullscreen chat shell) render the way the Android client paints them.
  </p>

  {#each entries(SAMPLES.ChatShellView) as [name, p] (name)}
    <GalleryCard label={`ChatShellView · ${name} · mobile`}>
      <div
        class="relative mx-auto flex w-[360px] h-[720px] overflow-hidden rounded-large border border-default-200 bg-surface"
      >
        <ChatShellView
          {...p as ComponentProps<typeof ChatShellView>}
          coreBar={chatCoreBar}
          sessionBar={chatSessionBar}
          input={chatInput}
          transcript={chatTranscript}
        />
      </div>
    </GalleryCard>
  {/each}

  <GalleryCard label="SettingsShellView · stacked · mobile">
    <div
      class="relative mx-auto flex w-[360px] h-[720px] overflow-hidden rounded-large border border-default-200 bg-surface"
    >
      <SettingsShellView {...SAMPLES.SettingsShellView.default as ComponentProps<typeof SettingsShellView>}>
        {#snippet groupContent(gid)}
          <SettingsContentView groupId={gid} values={SAMPLE_VALUES} expanded={expandedFor(gid)} />
        {/snippet}
        {#snippet sidebarFooter(collapsed)}
          <SettingsDemoFooter {collapsed} />
        {/snippet}
      </SettingsShellView>
    </div>
  </GalleryCard>

  <GalleryCard label="Modal · sheet · mobile">
    <div
      class="relative mx-auto w-[360px] h-[720px] overflow-hidden rounded-large border border-default-200 bg-surface"
    >
      <Modal open onclose={noop} ariaLabel="Bottom sheet">
        <h3 class="text-base font-medium text-default-800">Bottom sheet</h3>
        <p class="text-sm text-default-600">
          On touch every modal presents as a bottom sheet: a grab handle,
          drag-to-dismiss, and a slide-up transition, inherited from the one
          shared primitive.
        </p>
      </Modal>
    </div>
  </GalleryCard>

  <GalleryCard label="ActionSheet · mobile">
    <div
      class="relative mx-auto w-[360px] h-[720px] overflow-hidden rounded-large border border-default-200 bg-surface"
    >
      <ActionSheet
        open
        onclose={noop}
        title="Message"
        items={[
          { label: "Copy", icon: "i-material-symbols-content-copy-outline-rounded", onSelect: noop },
          { label: "Edit", icon: "i-material-symbols-edit-outline-rounded", onSelect: noop },
          {
            label: "Delete",
            icon: "i-material-symbols-delete-outline-rounded",
            onSelect: noop,
            destructive: true,
          },
        ]}
      />
    </div>
  </GalleryCard>

  {#each entries(SAMPLES.SnippetAutocompleteView) as [name, p] (name)}
    <GalleryCard label={`SnippetAutocompleteView · ${name} · mobile`}>
      <!-- The mobile sheet is position:fixed and opens upward from `anchor.top`;
           a transformed frame makes it the containing block, and a near-viewport
           anchor pins the sheet to the frame's bottom edge. -->
      <div
        class="relative mx-auto w-[360px] h-[720px] overflow-hidden rounded-large border border-default-200 bg-surface"
        style="transform: translateZ(0)"
      >
        <SnippetAutocompleteView
          {...p as ComponentProps<typeof SnippetAutocompleteView>}
          anchor={{ top: 680, left: 0 }}
        />
      </div>
    </GalleryCard>
  {/each}
</section>

<!-- Chat-shell region stand-ins for the mobile card (a core chip, a session
     title, a composer, a couple of transcript rows). -->
{#snippet chatCoreBar()}
  <div class="rounded-large bg-surface-inset px-3 py-2 text-sm text-default-600">
    tomat core · connected
  </div>
{/snippet}
{#snippet chatSessionBar(_z: number)}
  <div class="rounded-large bg-surface-inset px-3 py-2 text-sm font-medium text-default-700">
    Planning the week
  </div>
{/snippet}
{#snippet chatInput()}
  <div class="rounded-large bg-surface-inset px-3 py-3 text-sm text-default-500">
    Message tomat…
  </div>
{/snippet}
{#snippet chatTranscript()}
  <div class="w-fit rounded-large bg-surface px-4 py-2 text-sm text-default-800 shadow">
    Can you summarize my notes?
  </div>
  <div class="w-fit rounded-large bg-surface px-4 py-2 text-sm text-default-800 shadow">
    Here is a short summary of your notes.
  </div>
{/snippet}
