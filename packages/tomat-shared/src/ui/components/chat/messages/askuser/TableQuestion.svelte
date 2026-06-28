<script lang="ts">
  import type { AskUserTableQuestion } from "../../../../../domain/session.ts";
  import type { DraftAnswer } from "../ToolCallView.svelte";

  let { q, qi, draft, unselectedClasses, setCell, addRow, removeRow }: {
    q: AskUserTableQuestion;
    qi: number;
    draft: DraftAnswer | undefined;
    unselectedClasses: string;
    setCell: (idx: number, row: number, col: number, value: string) => void;
    addRow: (idx: number, columns: number) => void;
    removeRow: (idx: number, row: number) => void;
  } = $props();
</script>

<div class="overflow-x-auto">
  <table class="text-xs border-separate border-spacing-1">
    <thead>
      <tr>
        {#each q.columns as col (col)}
          <th class="text-left font-semibold text-default-600 px-2">
            {col}
          </th>
        {/each}
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each draft?.rows ?? [] as row, ri (ri)}
        <tr>
          {#each q.columns as _col, ci (ci)}
            <td>
              <input
                type="text"
                data-tc-nav
                class="bg-surface-inset text-default-800 rounded block w-full min-w-20 h-7 px-2 outline-none text-xs"
                value={row[ci] ?? ""}
                oninput={(e) =>
                  setCell(qi, ri, ci, (e.target as HTMLInputElement).value)}
              />
            </td>
          {/each}
          <td>
            <button
              type="button"
              data-tc-nav
              data-tc-aux
              class="flex items-center justify-center h-7 w-7 rounded cursor-pointer outline-none transition-colors duration-100 {unselectedClasses}"
              title="Remove row"
              onclick={() => removeRow(qi, ri)}
            >
              <i class="i-material-symbols-close-rounded"></i>
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<button
  type="button"
  data-tc-nav
  data-tc-aux
  class="self-start flex items-center gap-1 text-xs px-2 py-1 h-7 rounded cursor-pointer outline-none transition-colors duration-100 {unselectedClasses}"
  onclick={() => addRow(qi, q.columns.length)}
>
  <i class="i-material-symbols-add-rounded"></i>
  Add Row
</button>
