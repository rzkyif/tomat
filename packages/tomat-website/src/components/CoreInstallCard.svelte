<script lang="ts">
  // OS selector + one-line command for installing the core, with toggles that
  // fold the installer's environment variables into the command. Mirrors
  // InstallCard (Tabs, click-to-copy, How-to steps) and reuses the app's shared
  // Toggle/Select primitives for the controls. The command set mirrors the
  // published installer under get.au.tomat.ing/install/core.*; env vars must sit
  // on the `bash` side of the pipe (not before `curl`), and as `$env:` lines on
  // Windows.
  import Tabs from "@tomat/shared/ui/components/primitives/Tabs.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";
  import Toggle from "@tomat/shared/ui/components/primitives/Toggle.svelte";
  import Select from "@tomat/shared/ui/components/primitives/Select.svelte";

  type Os = "macos" | "linux" | "windows";

  const osTabs = [
    { id: "macos", label: "macOS" },
    { id: "linux", label: "Linux" },
    { id: "windows", label: "Windows" },
  ];

  const channelOptions = [
    { value: "stable", label: "Stable" },
    { value: "latest", label: "Latest" },
    { value: "dev", label: "Dev" },
  ];

  const steps: Record<Os, string[]> = {
    macos: [
      "Open Terminal.",
      "Paste the command above and press Return.",
      "When it finishes, note the pairing code it prints.",
    ],
    linux: [
      "Open your terminal.",
      "Paste the command above and press Enter.",
      "When it finishes, note the pairing code it prints.",
    ],
    windows: [
      "Open PowerShell.",
      "Paste the command above and press Enter.",
      "When it finishes, note the pairing code it prints.",
    ],
  };

  let os = $state<Os>("macos");
  let channel = $state("stable");
  let networkAccess = $state(false);
  let runInBackground = $state(true);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // The env vars the toggles add, in installer order. Stable + background + no
  // network access is the bare default and adds nothing.
  const envVars = $derived.by(() => {
    const vars: Array<[string, string]> = [];
    if (channel !== "stable") vars.push(["TOMAT_CHANNEL", channel]);
    if (networkAccess) vars.push(["TOMAT_INSTALL_BIND_ALL", "1"]);
    if (!runInBackground) vars.push(["TOMAT_INSTALL_SERVICE", "0"]);
    return vars;
  });

  const command = $derived.by(() => {
    if (os === "windows") {
      const prefix = envVars.map(([k, v]) => `$env:${k}="${v}"; `).join("");
      return `${prefix}irm https://get.au.tomat.ing/install/core.ps1 | iex`;
    }
    // macOS/Linux: env vars belong on the `bash` side of the pipe so the script
    // (not curl) sees them.
    const env = envVars.map(([k, v]) => `${k}=${v} `).join("");
    return `curl -fsSL https://get.au.tomat.ing/install/core.sh | ${env}bash`;
  });

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

<!-- `not-prose`: see InstallCard. Keeps the card identical inside and outside the
     manual's `.prose` typography. -->
<div class="not-prose w-full max-w-xl mx-auto flex flex-col gap-2">
  <div class="w-56 mx-auto">
    <Tabs tabs={osTabs} active={os} onSelect={(id) => (os = id as Os)} slideMs={300} />
  </div>

  <div class="flex flex-col gap-2 rounded-large bg-surface-inset px-4 py-3">
    <label class="flex items-center justify-between gap-4">
      <span class="text-sm text-default-700">Channel</span>
      <div class="w-32">
        <Select value={channel} options={channelOptions} onchange={(v) => (channel = v)} />
      </div>
    </label>
    <label class="flex items-center justify-between gap-4">
      <span class="text-sm text-default-700">Allow access from other machines</span>
      <div class="shrink-0">
        <Toggle
          variant="pill"
          checked={networkAccess}
          onchange={(v) => (networkAccess = v)}
          ariaLabel="Allow access from other machines"
        />
      </div>
    </label>
    <label class="flex items-center justify-between gap-4">
      <span class="text-sm text-default-700">Run in the background at login</span>
      <div class="shrink-0">
        <Toggle
          variant="pill"
          checked={runInBackground}
          onchange={(v) => (runInBackground = v)}
          ariaLabel="Run in the background at login"
        />
      </div>
    </label>
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
