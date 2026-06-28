<script lang="ts">
  // Presentational body of a memory's detail pane: the enable toggle with a
  // kind/read-only subtitle, the index-status line with a regenerate action,
  // the title field, the content (or SKILL.md instructions) with an
  // edit/preview toggle, and, for skills, the suggested-tools line and the
  // bundled-files list with an inline file viewer/editor. All values arrive
  // pre-resolved (the client owns the store, the loaded content, the
  // editability and skill flags, the index status, and the draft wiring), so
  // this stays pure: props in, callbacks out. The detail header and scroll
  // shell live in ../objects/*; this is only MemoryDetail's own body markup.
  // `draftContent` and `openFileContent` are $bindable to mirror the client's
  // textarea drafts.
  import FormField from "../primitives/FormField.svelte";
  import Input from "../primitives/Input.svelte";
  import Textarea from "../primitives/Textarea.svelte";
  import Toggle from "../primitives/Toggle.svelte";
  import Button from "../primitives/Button.svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import SubsectionHeader from "../primitives/SubsectionHeader.svelte";
  import ListItem from "../primitives/ListItem.svelte";
  import Card from "../primitives/Card.svelte";
  import Markdown from "../primitives/Markdown.svelte";

  let {
    enabled = false,
    isSkill = false,
    editable = false,
    draftTitle = "",
    titleError = null,
    contentLoaded = false,
    summarized = false,
    summaryStale = false,
    reindexing = false,
    suggestedTools = [],
    files = [],
    draftContent = $bindable(""),
    openFileName = null,
    openFileContent = $bindable(""),
    openFileLoaded = false,
    onToggleEnabled,
    onTitleInput,
    onTitleBlur,
    onContentInput,
    onContentBlur,
    onReindex,
    onOpenFile,
    onCloseFile,
    onFileContentInput,
    onFileContentBlur,
    onAddFile,
    onDeleteFile,
  }: {
    enabled?: boolean;
    isSkill?: boolean;
    editable?: boolean;
    draftTitle?: string;
    titleError?: string | null;
    contentLoaded?: boolean;
    summarized?: boolean;
    summaryStale?: boolean;
    reindexing?: boolean;
    suggestedTools?: string[];
    files?: string[];
    draftContent?: string;
    openFileName?: string | null;
    openFileContent?: string;
    openFileLoaded?: boolean;
    onToggleEnabled?: (enabled: boolean) => void;
    onTitleInput?: (v: string) => void;
    onTitleBlur?: () => void;
    onContentInput?: (v: string) => void;
    onContentBlur?: () => void;
    onReindex?: () => void;
    onOpenFile?: (name: string) => void;
    onCloseFile?: () => void;
    onFileContentInput?: (v: string) => void;
    onFileContentBlur?: () => void;
    onAddFile?: (name: string) => void;
    onDeleteFile?: (name: string) => void;
  } = $props();

  const noop = (): void => {};

  // Inline "new bundled file" name entry, view-local: the + button reveals it,
  // submitting hands the trimmed name to the client (which creates + opens it).
  let addingFile = $state(false);
  let newFileName = $state("");
  function submitNewFile(): void {
    const name = newFileName.trim();
    if (name) (onAddFile ?? noop)(name);
    newFileName = "";
    addingFile = false;
  }

  // Edit/preview is view-local UI state, not domain: which way the user is
  // currently looking at the markdown body. Resets to edit per mount.
  let preview = $state(false);

  // The index status as a single two-line item: a title line and a plain
  // second line explaining what it means for the user. The agent surfaces a
  // memory by relevance from its summary, so until one is current the memory
  // won't come up on its own (you can still reference it by trigger).
  const status = $derived.by(() => {
    if (!summarized) {
      return {
        icon: "i-material-symbols-info-outline-rounded",
        tone: "text-accent-yellow-700",
        title: "Not Summarized",
        detail: "Won't surface by relevance until it's summarized.",
      };
    }
    if (summaryStale) {
      return {
        icon: "i-material-symbols-info-outline-rounded",
        tone: "text-accent-yellow-700",
        title: "Summary Outdated",
        detail: "Edited since its last summary.",
      };
    }
    return {
      icon: "i-material-symbols-check-circle-outline-rounded",
      tone: "text-default-500",
      title: "Summarized",
      detail: "Can surface when it's relevant to your message.",
    };
  });
</script>

<div class="flex flex-col gap-3">
  <FormField
    label="Enabled"
    description={`${isSkill ? "Skill" : "Knowledge"}${
      editable ? "" : " · provided by an extension (read-only)"
    }`}
    descriptionTier="always"
    horizontal
  >
    <Toggle
      checked={enabled}
      ariaLabel="Enable memory"
      onchange={(v) => (onToggleEnabled ?? noop)(v)}
    />
  </FormField>

  <div class="flex items-center gap-2">
    <i class="{status.icon} {status.tone} shrink-0"></i>
    <div class="flex flex-col min-w-0">
      <span class="text-xs text-default-700">{status.title}</span>
      <span class="text-xs text-default-500">{status.detail}</span>
    </div>
    <div class="flex-1"></div>
    <Button
      variant="secondary"
      size="sm"
      icon="i-material-symbols-refresh-rounded"
      loading={reindexing}
      onclick={() => (onReindex ?? noop)()}
    >
      Regenerate Summary
    </Button>
  </div>

  <FormField label="Title" error={editable ? titleError : null}>
    <Input
      type="text"
      value={draftTitle}
      ariaLabel="Memory title"
      disabled={!editable}
      error={editable ? !!titleError : false}
      oninput={(v) => (onTitleInput ?? noop)(v)}
      onblur={() => (onTitleBlur ?? noop)()}
    />
  </FormField>

  <div class="flex flex-col gap-2 text-sm">
    <div class="flex items-center gap-2">
      <div class="flex-1 text-default-800">{isSkill ? "Instructions (SKILL.md)" : "Content"}</div>
      <Button variant="ghost" size="sm" onclick={() => (preview = !preview)}>
        {preview ? "Edit" : "Preview"}
      </Button>
    </div>
    {#if preview}
      <Card variant="raised" padding="sm" class="min-h-48 max-h-96 overflow-y-auto">
        {#if draftContent.trim()}
          <Markdown content={draftContent} />
        {:else}
          <div class="text-default-400 italic">Nothing to preview.</div>
        {/if}
      </Card>
    {:else}
      <Textarea
        ariaLabel="Memory content"
        autoResize="none"
        class="min-h-48 overflow-y-auto resize-y font-mono"
        value={draftContent}
        placeholder={contentLoaded ? "" : "Loading..."}
        disabled={!contentLoaded || !editable}
        oninput={(v) => (onContentInput ?? noop)(v)}
        onblur={() => (onContentBlur ?? noop)()}
      />
    {/if}
  </div>

  {#if isSkill && suggestedTools.length > 0}
    <div class="text-xs text-default-600">
      Suggested tools: <span class="font-mono">{suggestedTools.join(", ")}</span>
    </div>
  {/if}

  {#if isSkill}
    <div class="flex flex-col gap-1">
      <SubsectionHeader label="Bundled files">
        {#snippet actions()}
          {#if editable}
            <IconButton
              icon="i-material-symbols-add-rounded"
              title="Add file"
              size="xs"
              variant="subtle"
              active={addingFile}
              onclick={() => (addingFile = !addingFile)}
            />
          {/if}
        {/snippet}
      </SubsectionHeader>
      {#if addingFile}
        <div class="flex items-center gap-2">
          <Input
            type="text"
            value={newFileName}
            ariaLabel="New file name"
            placeholder="checklist.md"
            class="flex-1 text-xs font-mono"
            oninput={(v) => (newFileName = v)}
            onkeydown={(e) => {
              if (e.key === "Enter") submitNewFile();
              else if (e.key === "Escape") {
                newFileName = "";
                addingFile = false;
              }
            }}
          />
          <Button variant="secondary" size="sm" onclick={submitNewFile}>Add</Button>
        </div>
      {/if}
      {#if files.length === 0 && !addingFile}
        <div class="text-xs text-default-400 italic">No bundled files.</div>
      {/if}
      {#each files as f (f)}
        <div class="flex flex-col gap-1">
          <ListItem
            selected={openFileName === f}
            onclick={() => (openFileName === f ? (onCloseFile ?? noop)() : (onOpenFile ?? noop)(f))}
          >
            {#snippet leading()}
              <i
                class="{openFileName === f
                  ? 'i-material-symbols-folder-open-outline-rounded'
                  : 'i-material-symbols-description-outline-rounded'} text-default-500 shrink-0"
              ></i>
            {/snippet}
            <span class="text-xs font-mono truncate">{f}</span>
            {#snippet trailing()}
              {#if editable}
                <IconButton
                  icon="i-material-symbols-delete-outline-rounded"
                  title="Delete file"
                  size="xs"
                  variant="subtle"
                  onclick={() => (onDeleteFile ?? noop)(f)}
                />
              {/if}
            {/snippet}
          </ListItem>
          {#if openFileName === f}
            <Textarea
              ariaLabel="Bundled file content"
              autoResize="none"
              class="min-h-32 overflow-y-auto resize-y font-mono text-xs"
              value={openFileContent}
              placeholder={openFileLoaded ? "" : "Loading..."}
              disabled={!openFileLoaded || !editable}
              oninput={(v) => (onFileContentInput ?? noop)(v)}
              onblur={() => (onFileContentBlur ?? noop)()}
            />
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
