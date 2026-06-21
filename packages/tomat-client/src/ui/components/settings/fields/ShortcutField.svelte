<script lang="ts">
  import type { SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import { settingsState } from "../../../state";
  import FieldCard from "./FieldCard.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";

  let {
    field,
    error,
    horizontal = false,
    onChange,
    onReset,
  } = $props<{
    field: SettingField;
    error: string | null;
    horizontal?: boolean;
    onChange: (key: string, value: any) => void;
    onReset: (fieldId: string) => void;
  }>();

  const editable = $derived(
    evalCondition(field.editableWhen, settingsState.currentSettings),
  );
  const currentValue = $derived(
    (settingsState.currentSettings[field.id] ?? "") as string,
  );
  const hasError = $derived(!!error);

  let capturing = $state(false);

  // Map a KeyboardEvent.code to a Tauri accelerator key segment.
  // Returns null for keys that should not commit (modifiers, Escape).
  function codeToAcceleratorKey(code: string): string | null {
    if (code.startsWith("Key")) return code.slice(3).toLowerCase();
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) {
      const rest = code.slice(6);
      if (/^\d$/.test(rest)) return `num${rest}`;
      return null;
    }
    if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
    if (code.startsWith("Arrow")) return code.slice(5).toLowerCase();
    switch (code) {
      case "Space":
        return "space";
      case "Enter":
        return "enter";
      case "Tab":
        return "tab";
      case "Backspace":
        return "backspace";
      case "Delete":
        return "delete";
      case "Insert":
        return "insert";
      case "Home":
        return "home";
      case "End":
        return "end";
      case "PageUp":
        return "pageup";
      case "PageDown":
        return "pagedown";
      case "Minus":
        return "-";
      case "Equal":
        return "=";
      case "BracketLeft":
        return "[";
      case "BracketRight":
        return "]";
      case "Backslash":
        return "\\";
      case "Semicolon":
        return ";";
      case "Quote":
        return "'";
      case "Comma":
        return ",";
      case "Period":
        return ".";
      case "Slash":
        return "/";
      case "Backquote":
        return "`";
      default:
        return null;
    }
  }

  function buildAccelerator(e: KeyboardEvent): string | null {
    const key = codeToAcceleratorKey(e.code);
    if (!key) return null;
    const parts: string[] = [];
    if (e.metaKey) parts.push("super");
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    parts.push(key);
    return parts.join("+");
  }

  function startCapture() {
    if (!editable) return;
    capturing = true;
  }

  function clearShortcut(e: MouseEvent) {
    e.stopPropagation();
    if (!editable) return;
    onChange(field.id, "");
    capturing = false;
  }

  // Capture key combos at the window level so we don't depend on the button
  // having keyboard focus (WebKit doesn't focus buttons on click by default,
  // which would otherwise drop the keydown silently).
  $effect(() => {
    if (!capturing) return;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.code === "Escape") {
        capturing = false;
        return;
      }

      const accel = buildAccelerator(e);
      if (!accel) return; // lone modifier, wait for a real key

      onChange(field.id, accel);
      capturing = false;
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const segments = $derived(currentValue ? currentValue.split("+") : []);
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  <div class="flex flex-row items-center gap-1.5 w-full">
    <button
      type="button"
      aria-label={field.name}
      class="flex-1 min-h-8 px-2 py-1 rounded-medium text-left flex flex-row items-center gap-1 flex-wrap outline-none {!editable
        ? 'opacity-60 pointer-events-none'
        : ''} {capturing
        ? 'bg-surface-inset'
        : hasError
          ? 'bg-accent-red-300 border-accent-red-400'
          : 'bg-surface-inset cursor-pointer'}"
      onclick={startCapture}
    >
      {#if capturing}
        <span class="text-default-600 text-sm italic">
          Press a key combination… (Esc to cancel)
        </span>
      {:else if segments.length === 0}
        <span class="text-default-500 text-sm italic">Disabled</span>
      {:else}
        {#each segments as seg, i}
          {#if i > 0}
            <span class="text-default-500 text-xs">+</span>
          {/if}
          <kbd
            class="bg-surface-inset-strong text-default-800 px-1.5 py-0.5 rounded text-xs font-mono uppercase tracking-wide"
          >
            {seg}
          </kbd>
        {/each}
      {/if}
    </button>

    {#if editable && currentValue}
      <IconButton
        icon="i-material-symbols-delete-outline-rounded"
        title="Clear shortcut"
        size="sm"
        variant="subtle"
        onclick={clearShortcut}
        colorClass="text-default-400 hov:text-accent-red-500"
      />
    {/if}
  </div>
</FieldCard>
