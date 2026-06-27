<script lang="ts">
  // Presentational body of a memory's detail pane: the enable toggle with a
  // kind/read-only subtitle, the title field, the content (or SKILL.md
  // instructions) textarea, and, for skills, the suggested-tools line and the
  // bundled-files list. All values arrive pre-resolved (the client owns the
  // store, the loaded content, the editability and skill flags, and the draft
  // wiring), so this stays pure: props in, callbacks out. The detail header and
  // scroll shell live in ../objects/*; this is only MemoryDetail's own body
  // markup. `draftContent` is $bindable to mirror the client's textarea draft.
  import FormField from "../primitives/FormField.svelte";
  import Input from "../primitives/Input.svelte";
  import Textarea from "../primitives/Textarea.svelte";
  import Toggle from "../primitives/Toggle.svelte";

  let {
    enabled = false,
    isSkill = false,
    editable = false,
    draftTitle = "",
    titleError = null,
    contentLoaded = false,
    suggestedTools = [],
    files = [],
    draftContent = $bindable(""),
    onToggleEnabled,
    onTitleInput,
    onTitleBlur,
    onContentInput,
    onContentBlur,
  }: {
    enabled?: boolean;
    isSkill?: boolean;
    editable?: boolean;
    draftTitle?: string;
    titleError?: string | null;
    contentLoaded?: boolean;
    suggestedTools?: string[];
    files?: string[];
    draftContent?: string;
    onToggleEnabled?: (enabled: boolean) => void;
    onTitleInput?: (v: string) => void;
    onTitleBlur?: () => void;
    onContentInput?: (v: string) => void;
    onContentBlur?: () => void;
  } = $props();

  const noop = (): void => {};
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-sm text-default-800">Enabled</span>
      <span class="text-xs text-default-600">
        {isSkill ? "Skill" : "Knowledge"}{editable ? "" : " · provided by an extension (read-only)"}
      </span>
    </div>
    <Toggle
      compact
      labels={{ on: "ON", off: "OFF" }}
      checked={enabled}
      ariaLabel="Enable memory"
      onchange={(v) => (onToggleEnabled ?? noop)(v)}
    />
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

  <FormField label={isSkill ? "Instructions (SKILL.md)" : "Content"}>
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
  </FormField>

  {#if isSkill && suggestedTools.length > 0}
    <div class="text-xs text-default-600">
      Suggested tools: <span class="font-mono">{suggestedTools.join(", ")}</span>
    </div>
  {/if}

  {#if isSkill && files.length > 0}
    <div class="flex flex-col gap-1">
      <div class="text-default-400 text-[10px] uppercase tracking-wider select-none">
        Bundled files
      </div>
      {#each files as f (f)}
        <code class="text-xs text-default-700">{f}</code>
      {/each}
    </div>
  {/if}
</div>
