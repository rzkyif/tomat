<script lang="ts">
  // OS selector + one-line install command, reusing the app's Tabs and
  // IconButton. Clicking anywhere on the card copies the command; the copy icon
  // flips to a check for a moment. The command set mirrors the published
  // installers under get.au.tomat.ing/install.
  import Tabs from "@tomat/shared/ui/components/primitives/Tabs.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";

  type Os = "macos" | "linux" | "windows";

  const osTabs = [
    { id: "macos", label: "macOS" },
    { id: "linux", label: "Linux" },
    { id: "windows", label: "Windows" },
  ];

  const commands: Record<Os, string> = {
    macos: "curl -fsSL https://get.au.tomat.ing/install/client.sh | sh",
    linux: "curl -fsSL https://get.au.tomat.ing/install/client.sh | sh",
    windows: "irm https://get.au.tomat.ing/install/client.ps1 | iex",
  };

  const steps: Record<Os, string[]> = {
    macos: [
      "Open Terminal.",
      "Paste the command above and press Return.",
      "When it finishes, launch tomat from Applications.",
    ],
    linux: [
      "Open your terminal.",
      "Paste the command above and press Enter.",
      "Launch tomat from your application menu or run `tomat`.",
    ],
    windows: [
      "Open PowerShell.",
      "Paste the command above and press Enter.",
      "Launch tomat from the Start menu.",
    ],
  };

  let os = $state<Os>("macos");
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const command = $derived(commands[os]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (_) {
      // clipboard unavailable: the command stays selectable for manual copy
    }
  }
</script>

<div class="w-full max-w-xl mx-auto flex flex-col gap-2">
  <div class="w-56 mx-auto">
    <Tabs tabs={osTabs} active={os} onSelect={(id) => (os = id as Os)} slideMs={300} />
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    onclick={copy}
    title="Copy install command"
    class="group flex items-center gap-3 px-4 py-3 rounded-large bg-surface-inset hover:bg-surface-inset-strong transition-colors hover:cursor-pointer"
  >
    <code
      class="font-mono text-sm text-default-800 overflow-x-auto whitespace-nowrap flex-1 no-scrollbar"
    >{command}</code>
    <IconButton
      icon={copied
        ? "i-material-symbols-check-rounded"
        : "i-material-symbols-content-copy-outline-rounded"}
      title={copied ? "Copied" : "Copy"}
      colorClass={copied ? "text-accent-green-600" : "text-default-600 group-hover:text-default-900"}
      onclick={copy}
    />
  </div>

  <details class="expandable rounded-large bg-surface-inset px-4 py-3">
    <summary
      class="flex items-center gap-1 text-sm text-default-700 hover:text-default-900 hover:cursor-pointer select-none"
    >
      <i class="expandable-chevron flex i-material-symbols-chevron-right-rounded -ml-1 text-lg"></i>
      How to install
    </summary>
    <ol class="mt-3 flex flex-col gap-2 text-sm text-default-700 list-decimal pl-5">
      {#each steps[os] as step (step)}
        <li>{step}</li>
      {/each}
    </ol>
  </details>
</div>
