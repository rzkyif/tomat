<script lang="ts">
  import { untrack } from "svelte";
  import type { SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import { colorPickerState, settingsState } from "../../../state";
  import {
    darkFromLight,
    isValidHex,
    lightFromDark,
    toEightCharHex,
  } from "$lib/shared/color";
  import FieldCard from "./FieldCard.svelte";
  import Input from "../../ui/Input.svelte";

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

  // The stored value is always the light-mode hex (8-char with alpha). We
  // re-render it as the dark variant when the user is currently looking at
  // the dark theme so the picker shows what they're editing in context.
  const themeMql =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  let systemDark = $state(themeMql?.matches ?? false);
  $effect(() => {
    if (!themeMql) return;
    const handler = (e: MediaQueryListEvent) => (systemDark = e.matches);
    themeMql.addEventListener("change", handler);
    return () => themeMql.removeEventListener("change", handler);
  });
  const isDark = $derived.by(() => {
    const theme = settingsState.currentSettings["appearance.theme"];
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return systemDark;
  });

  const storedLight = $derived(
    settingsState.currentSettings[field.id] as string,
  );
  const displayedHex = $derived(
    isDark ? darkFromLight(storedLight) : storedLight,
  );

  let hexInput = $state(untrack(() => displayedHex));
  let inputError = $state(false);
  let inputFocused = $state(false);
  $effect(() => {
    const next = displayedHex;
    if (!inputFocused) hexInput = next;
  });

  let swatchEl: HTMLButtonElement | undefined = $state();

  function commitDisplayedHex(newDisplayed: string) {
    const eight = toEightCharHex(newDisplayed);
    const lightHex = isDark ? lightFromDark(eight) : eight;
    onChange(field.id, lightHex);
  }

  function openPicker() {
    if (!swatchEl) return;
    colorPickerState.open({
      anchor: swatchEl,
      initialHex: toEightCharHex(displayedHex),
      onApply: commitDisplayedHex,
    });
  }

  function handleHexBlur() {
    inputFocused = false;
    if (!isValidHex(hexInput)) {
      hexInput = displayedHex;
      inputError = false;
    }
  }
</script>

<FieldCard {field} {error} {horizontal} {onReset}>
  <div
    class="flex flex-row items-center gap-2 w-full {!editable
      ? 'opacity-60 pointer-events-none'
      : ''}"
  >
    <button
      bind:this={swatchEl}
      type="button"
      class="alpha-checkerboard relative h-8 w-8 border-4 border-default-300 shrink-0 rounded-medium overflow-hidden cursor-pointer"
      title="Open color picker"
      aria-label="Open color picker"
      disabled={!editable}
      onclick={openPicker}
    >
      <!-- Inset by -1px so the colored layer slightly overhangs the parent's
           edges; combined with the parent's overflow-hidden + rounded corners,
           this guarantees the color reaches the rounded edge with no
           sub-pixel gap to the checkerboard background. -->
      <span class="absolute inset-[-4px]" style:background-color={displayedHex}
      ></span>
    </button>

    <Input
      type="text"
      value={hexInput}
      placeholder="#rrggbbaa"
      maxlength={9}
      spellcheck={false}
      autocomplete="off"
      disabled={!editable}
      error={inputError}
      mono
      uppercase
      ariaLabel="{field.name} hex value"
      onfocus={() => (inputFocused = true)}
      oninput={(v) => {
        hexInput = v.trim();
        if (isValidHex(hexInput)) {
          inputError = false;
          commitDisplayedHex(hexInput);
        } else {
          inputError = true;
        }
      }}
      onblur={handleHexBlur}
    />
  </div>
</FieldCard>
