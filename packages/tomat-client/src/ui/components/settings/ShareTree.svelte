<script lang="ts">
  // Group -> section -> field selector shared by the import and export tabs.
  // For group/section rows, clicking the checkbox or its label selects
  // (cascading to descendants with a tri-state parent), while clicking the rest
  // of the row (chevron, trailing space) expands; fields select only. Collapsed
  // by default. Fields flagged `warn` (an import that would overwrite a
  // customized value) render in the warning accent with an icon, propagated to
  // parents. Fields flagged `disabled` (not applicable: importing them is a
  // no-op) render dim with a disabled, indeterminate checkbox; a section/group
  // whose every field is disabled is itself shown disabled.
  import { type TreeField, type TreeGroup } from "$lib/settings/share";
  import Checkbox from "../ui/Checkbox.svelte";

  let {
    nodes,
    selected = $bindable<Set<string>>(new Set()),
  }: {
    nodes: TreeGroup[];
    selected?: Set<string>;
  } = $props();

  let expanded = $state<Set<string>>(new Set());

  function toggleExpanded(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  type Tri = "all" | "some" | "none";

  function triState(ids: string[]): Tri {
    if (ids.length === 0) return "none";
    let n = 0;
    for (const id of ids) if (selected.has(id)) n++;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
  }

  function setIds(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    selected = next;
  }

  // A group's fields are its inline (direct) fields plus every section field.
  function groupFields(g: TreeGroup): TreeField[] {
    return [...g.fields, ...g.sections.flatMap((s) => s.fields)];
  }
</script>

{#snippet warnIcon()}
  <i class="flex i-material-symbols-warning-outline-rounded text-accent-yellow-600 shrink-0"></i>
{/snippet}

{#snippet parentRow(label: string, fields: TreeField[], key: string, indent: string)}
  {@const applicable = fields.filter((f) => !f.disabled).map((f) => f.id)}
  {@const fullyDisabled = applicable.length === 0}
  {@const warns = fields.some((f) => f.warn)}
  {@const tri = triState(applicable)}
  <!-- The row body (chevron + empty space) toggles expand; the checkbox/label
       region selects and stops the click from bubbling to expand. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex items-center gap-0.5 rounded-medium py-1 pr-2 hover:bg-surface-inset hover:cursor-pointer {indent}"
    title={expanded.has(key) ? "Collapse" : "Expand"}
    onclick={() => toggleExpanded(key)}
  >
    <i
      class="flex shrink-0 i-material-symbols-chevron-right-rounded text-base text-default-500 transition-transform {expanded.has(
        key,
      )
        ? 'rotate-90'
        : ''}"
    ></i>
    {#if fullyDisabled}
      <div class="flex items-center gap-1.5 min-w-0">
        <Checkbox disabled indeterminate />
        <span class="truncate text-sm text-default-400">{label}</span>
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <label
        class="flex items-center gap-1.5 min-w-0 select-none hover:cursor-pointer"
        onclick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={tri === "all"}
          indeterminate={tri === "some"}
          onchange={() => setIds(applicable, tri !== "all")}
        />
        <span class="truncate text-sm text-default-800">{label}</span>
        {#if warns}{@render warnIcon()}{/if}
      </label>
    {/if}
  </div>
{/snippet}

{#snippet fieldRow(field: TreeField, indent: string)}
  {#if field.disabled}
    <div class="flex items-center gap-1.5 rounded-medium py-1 pr-2 {indent}">
      <Checkbox disabled indeterminate />
      <span class="truncate text-sm text-default-400">{field.name}</span>
    </div>
  {:else}
    <label
      class="flex items-center gap-1.5 rounded-medium py-1 pr-2 select-none hover:bg-surface-inset hover:cursor-pointer {indent}"
    >
      <Checkbox
        checked={selected.has(field.id)}
        onchange={() => setIds([field.id], !selected.has(field.id))}
      />
      <span class="truncate text-sm {field.warn ? 'text-accent-yellow-700' : 'text-default-700'}"
        >{field.name}</span
      >
      {#if field.warn}{@render warnIcon()}{/if}
    </label>
  {/if}
{/snippet}

<div class="flex flex-col">
  {#each nodes as group (group.id)}
    {@render parentRow(group.name, groupFields(group), group.id, "")}
    {#if expanded.has(group.id)}
      {#each group.fields as field (field.id)}
        {@render fieldRow(field, "pl-8")}
      {/each}
      {#each group.sections as section (section.key)}
        {@render parentRow(section.label, section.fields, section.key, "pl-5")}
        {#if expanded.has(section.key)}
          {#each section.fields as field (field.id)}
            {@render fieldRow(field, "pl-13")}
          {/each}
        {/if}
      {/each}
    {/if}
  {/each}
</div>
