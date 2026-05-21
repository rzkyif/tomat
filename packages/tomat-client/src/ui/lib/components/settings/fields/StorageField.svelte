<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import FieldCard from "./FieldCard.svelte";

  // Storage browsing moved server-side after the rework: ~/.tomat/core/ is
  // owned by the paired core, not the client. The old `list_tomat_storage`
  // Tauri command was tied to the monolithic layout (single
  // ~/.tomat/ tree) and doesn't exist anymore. The field used to surface
  // a delete/reveal browser; that has no equivalent now (model + session
  // delete go through cores().api().models and cores().api().sessions
  // respectively, exposed elsewhere in Settings).
  //
  // Until a core-side storage browser endpoint is added, this field renders
  // a short informational note so the legacy schema entry still shows up
  // cleanly.

  let { field } = $props<{ field: SettingField }>();
</script>

<FieldCard {field}>
  <div class="text-default-500 text-xs leading-snug pb-1">
    Storage lives on the paired core under
    <code class="text-default-700">~/.tomat/core/</code>. Delete individual
    models from the Models section above and individual sessions from the
    session bar.
  </div>
</FieldCard>
