<script lang="ts">
  import { untrack } from "svelte";
  import type { SettingField } from "@tomat/shared";
  import { evalCondition } from "@tomat/shared";
  import { colorPickerState, settingsState } from "../../../state";
  import {
    darkFromLight,
    formatOklch,
    isValidColor,
    lightFromDark,
    parseColor,
    withLightness,
  } from "$lib/appearance/color";
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

  // The stored value is the light-mode color (an `oklch(...)` string, or a
  // legacy hex). We re-render it as the dark variant when the user is currently
  // in the dark theme so the picker shows what they're editing in context.
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

  // Seed colors (default/accent/override bases) only contribute hue+chroma to a
  // derived scale; the theme picks each shade's lightness. A field with
  // `lockedLightness` is pinned to that lightness -- the LIGHT-mode lightness of
  // the shade the color is seen at most (the default color uses bg-surface,
  // ~0.985). The picker hides the lightness slider. The value is still
  // theme-inverted for display, so the preview matches that exact shade in both
  // themes: darkFromLight(0.985) lands on the dark surface lightness, so the
  // dark preview equals --default-d-50 (= bg-surface in dark). Storing OKLCH
  // keeps chroma exact even at these near-white/near-black lightnesses (the
  // browser gamut-maps only at paint, exactly like the real surface does).
  // Colors rendered as-is (bubbles, shadow) leave it unset: free lightness slider.
  const lockedLightness = $derived(
    field.type === "color" ? field.lockedLightness : undefined,
  );

  const storedLight = $derived(
    settingsState.currentSettings[field.id] as string,
  );
  // Light-mode form: seed colors pinned to their locked lightness, others as
  // stored. Then theme-inverted for the dark theme.
  const lightForm = $derived(
    lockedLightness != null ? withLightness(storedLight, lockedLightness) : storedLight,
  );
  // Always an `oklch(...)` string matching how the color renders in the current
  // theme (legacy hex normalized to oklch).
  const displayedColor = $derived(
    isDark ? darkFromLight(lightForm) : formatOklch(parseColor(lightForm)),
  );

  let colorInput = $state(untrack(() => displayedColor));
  let inputError = $state(false);
  let inputFocused = $state(false);
  $effect(() => {
    const next = displayedColor;
    if (!inputFocused) colorInput = next;
  });

  let swatchEl: HTMLButtonElement | undefined = $state();

  function commitColor(newDisplayed: string) {
    // Normalize to our canonical oklch form so the no-op guard compares like
    // with like (and a pasted hex is converted to oklch on the way in).
    const next = formatOklch(parseColor(newDisplayed));
    // No-op guard: applying the value we're already showing must not rewrite
    // the store.
    if (next === displayedColor) return;
    // Convert the displayed (current-theme) value back to the light-mode form,
    // then pin seed colors to their locked lightness.
    const asLight = isDark ? lightFromDark(next) : next;
    const stored = lockedLightness != null
      ? withLightness(asLight, lockedLightness)
      : asLight;
    onChange(field.id, stored);
  }

  function openPicker() {
    if (!swatchEl) return;
    colorPickerState.open({
      anchor: swatchEl,
      initialColor: displayedColor,
      onApply: commitColor,
      lockLightness: lockedLightness != null,
    });
  }

  function handleColorBlur() {
    inputFocused = false;
    if (!isValidColor(colorInput)) {
      colorInput = displayedColor;
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
      <span class="absolute inset-[-4px]" style:background-color={displayedColor}
      ></span>
    </button>

    <Input
      type="text"
      value={colorInput}
      placeholder="oklch(L C H / A) or #hex"
      maxlength={40}
      spellcheck={false}
      autocomplete="off"
      disabled={!editable}
      error={inputError}
      mono
      ariaLabel="{field.name} value"
      onfocus={() => (inputFocused = true)}
      oninput={(v) => {
        colorInput = v.trim();
        if (isValidColor(colorInput)) {
          inputError = false;
          commitColor(colorInput);
        } else {
          inputError = true;
        }
      }}
      onblur={handleColorBlur}
    />
  </div>
</FieldCard>
