<script lang="ts">
  let { onclick, title = "Reset to default" } = $props<{
    onclick: () => void;
    title?: string;
  }>();
</script>

<button
  class="text-default-500 hover:text-blue-500 transition-colors py-1 shrink-0"
  {onclick}
  {title}
>
  <i class="flex i-material-symbols-refresh-rounded text-xl"></i>
</button>
