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
  import CoreBarView from "@tomat/shared/ui/components/chat/CoreBarView.svelte";
  import SessionBarView from "@tomat/shared/ui/components/chat/SessionBarView.svelte";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
  import SettingsShellView from "@tomat/shared/ui/components/settings/SettingsShellView.svelte";
  import SettingsContentView from "@tomat/shared/ui/components/settings/SettingsContentView.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import ActionSheet from "@tomat/shared/ui/components/primitives/ActionSheet.svelte";
  import { SETTINGS_SCHEMA } from "@tomat/shared/domain/settings/engine";
  import SettingsDemoFooter from "../demos/SettingsDemoFooter.svelte";
  import GalleryCard from "./GalleryCard.svelte";

  const noop = (): void => {};
  const D = getDefaultSettings();

  // The touch shell: coarse pointer. Schema defaults otherwise, exactly like the
  // client at default settings on a phone.
  setUiContext(
    makeUiContext({
      getSetting: (key) => D[key],
      platform: "mobile",
      pointer: "coarse",
    }),
  );

  const entries = <T,>(o: Record<string, T>) => Object.entries(o);

  // A short simulated session for the mobile ChatShellView card (mirrors the
  // desktop card), so the phone frame shows the real chat, not stand-ins.
  const CHAT_PROMPT = "How do I install tomat on macOS?";
  const CHAT_REASONING =
    "The user is on macOS, so the one-line installer is the simplest path; point them at the landing-page command and the launch step.";
  const CHAT_ANSWER =
    "Run the one-line installer from the landing page, then launch tomat from Applications. Want the per-OS steps?";

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
    The same shared components under a mobile UiContext, framed in a phone-sized viewport so their
    touch branches (bottom sheets, stacked settings, the fullscreen chat shell) render the way the
    Android client paints them.
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
      <SettingsShellView
        {...SAMPLES.SettingsShellView.default as ComponentProps<typeof SettingsShellView>}
      >
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
          On touch every modal presents as a bottom sheet: a grab handle, drag-to-dismiss, and a
          slide-up transition, inherited from the one shared primitive.
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
          {
            label: "Copy",
            icon: "i-material-symbols-content-copy-outline-rounded",
            onSelect: noop,
          },
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

<!-- Chat-shell regions for the mobile card: the REAL shared components on a short
     simulated session under the mobile UiContext, so the phone frame shows the
     actual touch chat (core bar, session bar, composer, and a prompt -> reasoning
     -> answer exchange), not stand-ins. -->
{#snippet chatCoreBar()}
  <!-- `onSettings` makes the mobile top-app-bar Settings gear render (it is
       dropped from the mobile composer, so this is its only entry point). -->
  <CoreBarView
    {...SAMPLES.CoreBarView.idle as ComponentProps<typeof CoreBarView>}
    onSettings={noop}
  />
{/snippet}
{#snippet chatSessionBar(_z: number)}
  <!-- The session-management buttons (list + new) always show with the bar. -->
  <SessionBarView
    {...SAMPLES.SessionBarView.default as ComponentProps<typeof SessionBarView>}
    onList={noop}
    onNew={noop}
  />
{/snippet}
{#snippet chatInput()}
  <UserInputView {...SAMPLES.UserInputView.empty as ComponentProps<typeof UserInputView>} />
{/snippet}
{#snippet chatTranscript()}
  <!-- Newest-first DOM order: the shell's transcript column is flex-col-reverse. -->
  <AgentMessageView kind="content" bgClass="bubble-agent">
    {#snippet body()}
      <span class="whitespace-pre-wrap break-words">{CHAT_ANSWER}</span>
    {/snippet}
  </AgentMessageView>
  <AgentMessageView kind="reasoning" reasoningDurationMs={3200}>
    {#snippet body()}
      <span>{CHAT_REASONING}</span>
    {/snippet}
  </AgentMessageView>
  <UserMessageView text={CHAT_PROMPT} />
{/snippet}
