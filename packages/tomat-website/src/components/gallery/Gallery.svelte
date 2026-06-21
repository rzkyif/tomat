<script lang="ts">
  import type { ComponentProps } from "svelte";
  // The component gallery: every shared `*View` rendered in isolation under each
  // of its registered samples, with NO UiContext provider mounted, so it paints
  // from DEFAULT_UI_CONTEXT exactly like a fresh app. It is the visual drift/QA
  // surface and the manual's screenshot source. Drift typing lives in the sample
  // files (`satisfies`); here we cast each bundle at the spread so this stays a
  // dumb renderer that supplies only the per-View child snippets.
  import {
    AGENT_ANSWER,
    AGENT_REASONING,
    SAMPLE_VALUES,
    SAMPLES,
  } from "@tomat/shared/ui/samples";
  import AgentMessageView from "@tomat/shared/ui/components/chat/messages/AgentMessageView.svelte";
  import AttachmentListView from "@tomat/shared/ui/components/chat/AttachmentListView.svelte";
  import DiffView from "@tomat/shared/ui/components/chat/messages/DiffView.svelte";
  import ErrorMessageView from "@tomat/shared/ui/components/chat/messages/ErrorMessageView.svelte";
  import ExpandableMessageView from "@tomat/shared/ui/components/chat/messages/ExpandableMessageView.svelte";
  import QuickModelBarView from "@tomat/shared/ui/components/chat/userinput/QuickModelBarView.svelte";
  import ReasoningTraceView from "@tomat/shared/ui/components/chat/messages/ReasoningTraceView.svelte";
  import RelevantMemoriesView from "@tomat/shared/ui/components/chat/messages/RelevantMemoriesView.svelte";
  import RelevantToolsView from "@tomat/shared/ui/components/chat/messages/RelevantToolsView.svelte";
  import SessionBarView from "@tomat/shared/ui/components/chat/SessionBarView.svelte";
  import SettingsContentView from "@tomat/shared/ui/components/settings/SettingsContentView.svelte";
  import SettingsFieldView from "@tomat/shared/ui/components/settings/SettingsFieldView.svelte";
  import SettingsHeaderView from "@tomat/shared/ui/components/settings/SettingsHeaderView.svelte";
  import SettingsShellView from "@tomat/shared/ui/components/settings/SettingsShellView.svelte";
  import SettingsSidebarView from "@tomat/shared/ui/components/settings/SettingsSidebarView.svelte";
  import SnippetAutocompleteView from "@tomat/shared/ui/components/chat/SnippetAutocompleteView.svelte";
  import ToolCallView from "@tomat/shared/ui/components/chat/messages/ToolCallView.svelte";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import UserMessageView from "@tomat/shared/ui/components/chat/messages/UserMessageView.svelte";
  import { SETTINGS_SCHEMA } from "@tomat/shared/domain/settings/engine";
  import SettingsDemoFooter from "../demos/SettingsDemoFooter.svelte";
  import GalleryCard from "./GalleryCard.svelte";

  const entries = <T,>(o: Record<string, T>) => Object.entries(o);

  // Static render: SettingsContentView's expand-on-mount `$effect` never runs, so
  // pass the default-open section keys explicitly (one per labeled, not
  // defaultCollapsed section) to match the live app.
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

<div class="mx-auto max-w-5xl px-4 py-10 flex flex-col gap-12">
  <header class="flex flex-col gap-1">
    <h1 class="text-2xl font-semibold">Component gallery</h1>
    <p class="text-default-500 text-sm">
      Every shared <code>@tomat/shared/ui</code> View rendered from its samples on default
      settings. Toggle the navbar theme to check light and dark.
    </p>
  </header>

  <!-- Chat -->
  <section class="flex flex-col gap-6">
    <h2 class="text-lg font-medium">Chat</h2>

    {#each entries(SAMPLES.UserMessageView) as [name, p] (name)}
      <GalleryCard label={`UserMessageView · ${name}`}>
        <UserMessageView {...p as ComponentProps<typeof UserMessageView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.AgentMessageView) as [name, p] (name)}
      <GalleryCard label={`AgentMessageView · ${name}`}>
        <AgentMessageView {...p as ComponentProps<typeof AgentMessageView>}>
          {#snippet body()}
            <span class="whitespace-pre-wrap break-words"
              >{p.kind === "content" ? AGENT_ANSWER : AGENT_REASONING}</span
            >
          {/snippet}
        </AgentMessageView>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.ReasoningTraceView) as [name, p] (name)}
      <GalleryCard label={`ReasoningTraceView · ${name}`}>
        <ReasoningTraceView {...p as ComponentProps<typeof ReasoningTraceView>}>
          {#snippet body()}
            <span>{AGENT_REASONING}</span>
          {/snippet}
        </ReasoningTraceView>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.AttachmentListView) as [name, p] (name)}
      <GalleryCard label={`AttachmentListView · ${name}`}>
        <AttachmentListView {...p as ComponentProps<typeof AttachmentListView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.ErrorMessageView) as [name, p] (name)}
      <GalleryCard label={`ErrorMessageView · ${name}`}>
        <ErrorMessageView {...p as ComponentProps<typeof ErrorMessageView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.ExpandableMessageView) as [name, p] (name)}
      <GalleryCard label={`ExpandableMessageView · ${name}`}>
        <ExpandableMessageView {...p as ComponentProps<typeof ExpandableMessageView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SessionBarView) as [name, p] (name)}
      <GalleryCard label={`SessionBarView · ${name}`}>
        <SessionBarView {...p as ComponentProps<typeof SessionBarView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.QuickModelBarView) as [name, p] (name)}
      <GalleryCard label={`QuickModelBarView · ${name}`}>
        <QuickModelBarView {...p as ComponentProps<typeof QuickModelBarView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.UserInputView) as [name, p] (name)}
      <GalleryCard label={`UserInputView · ${name}`}>
        <UserInputView {...p as ComponentProps<typeof UserInputView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.DiffView) as [name, p] (name)}
      <GalleryCard label={`DiffView · ${name}`}>
        <DiffView {...p as ComponentProps<typeof DiffView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.RelevantMemoriesView) as [name, p] (name)}
      <GalleryCard label={`RelevantMemoriesView · ${name}`}>
        <RelevantMemoriesView {...p as ComponentProps<typeof RelevantMemoriesView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.RelevantToolsView) as [name, p] (name)}
      <GalleryCard label={`RelevantToolsView · ${name}`}>
        <RelevantToolsView {...p as ComponentProps<typeof RelevantToolsView>} />
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.ToolCallView) as [name, p] (name)}
      <GalleryCard label={`ToolCallView · ${name}`}>
        <ToolCallView {...p as ComponentProps<typeof ToolCallView>}>
          {#snippet memoryContent({ content })}
            <pre class="whitespace-pre-wrap text-xs">{content}</pre>
          {/snippet}
        </ToolCallView>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SnippetAutocompleteView) as [name, p] (name)}
      <GalleryCard label={`SnippetAutocompleteView · ${name}`}>
        <!-- The dropdown is position:fixed; a transformed wrapper makes it a
             containing block so it stays inside the card instead of the page. -->
        <div class="relative w-72 h-40" style="transform: translateZ(0)">
          <SnippetAutocompleteView {...p as ComponentProps<typeof SnippetAutocompleteView>} />
        </div>
      </GalleryCard>
    {/each}
  </section>

  <!-- Settings -->
  <section class="flex flex-col gap-6">
    <h2 class="text-lg font-medium">Settings</h2>

    {#each entries(SAMPLES.SettingsFieldView) as [name, p] (name)}
      <GalleryCard label={`SettingsFieldView · ${name}`}>
        <div class="w-full max-w-md">
          <SettingsFieldView {...p as ComponentProps<typeof SettingsFieldView>} />
        </div>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SettingsHeaderView) as [name, p] (name)}
      <GalleryCard label={`SettingsHeaderView · ${name}`}>
        <div class="w-full max-w-lg">
          <SettingsHeaderView {...p as ComponentProps<typeof SettingsHeaderView>} />
        </div>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SettingsSidebarView) as [name, p] (name)}
      <GalleryCard label={`SettingsSidebarView · ${name}`}>
        <div class="h-96">
          <SettingsSidebarView {...p as ComponentProps<typeof SettingsSidebarView>} />
        </div>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SettingsContentView) as [name, p] (name)}
      <GalleryCard label={`SettingsContentView · ${name}`}>
        <div class="tomat-scroll-inset w-full h-[28rem] overflow-auto">
          <SettingsContentView
            {...p as ComponentProps<typeof SettingsContentView>}
            expanded={expandedFor((p as ComponentProps<typeof SettingsContentView>).groupId)}
          />
        </div>
      </GalleryCard>
    {/each}

    {#each entries(SAMPLES.SettingsShellView) as [name, p] (name)}
      <GalleryCard label={`SettingsShellView · ${name}`}>
        <SettingsShellView
          {...p as ComponentProps<typeof SettingsShellView>}
          sizeClass="w-[760px] max-w-full h-[28rem]"
        >
          {#snippet groupContent(gid)}
            <SettingsContentView groupId={gid} values={SAMPLE_VALUES} expanded={expandedFor(gid)} />
          {/snippet}
          {#snippet sidebarFooter(collapsed)}
            <SettingsDemoFooter {collapsed} />
          {/snippet}
        </SettingsShellView>
      </GalleryCard>
    {/each}
  </section>
</div>
