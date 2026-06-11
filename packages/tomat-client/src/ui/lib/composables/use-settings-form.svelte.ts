/**
 * The settings field-change engine shared by the full Settings panel and the
 * Quick Settings accordion: validation (required / optionalWhen / regex),
 * optimistic apply through `settingsState`, the preset-to-Custom flip for
 * managed keys, preset card application, and condition-dependency
 * re-evaluation. Extracted so both views get identical semantics.
 *
 * Reacting to a section's `expandWhen` is view-specific (only the full
 * Settings panel tracks expanded sections), so the constructor takes an
 * optional `onSectionExpand` hook instead of mutating view state directly.
 */

import type { PresetOption } from "@tomat/shared";
import {
  errMessage,
  evalCondition,
  findField,
  getConditionDeps,
  getPresetFieldIds,
  getValidationError,
  SETTINGS_SCHEMA,
} from "@tomat/shared";
import { settingsState } from "$lib/state/settings.svelte";

export class SettingsForm {
  /** Field id -> human-readable error, rendered by the field's FormField. */
  validationErrors = $state<Record<string, string>>({});

  /** `onSectionExpand` is called with a section key
   *  (`${groupId}-${sectionIndex}`) whenever a change re-evaluates that
   *  section's `expandWhen` condition. */
  constructor(private onSectionExpand?: (sectionKey: string, expand: boolean) => void) {}

  validateAllFields = (): void => {
    for (const group of SETTINGS_SCHEMA) {
      for (const section of group.sections) {
        for (const field of section.fields) {
          if (
            field.type === "command_preview" ||
            field.type === "services" ||
            field.type === "storage" ||
            field.type === "object_management"
          ) {
            continue;
          }
          const value = settingsState.currentSettings[field.id];
          this.validateField(field.id, value);
        }
      }
    }
  };

  // Apply optimistically. The core recomputes the required-files snapshot and
  // re-broadcasts it; the pending-downloads popup reacts with the full updated
  // list. No pre-download probe / revert here.
  handleChange = async (key: string, value: any): Promise<void> => {
    this.validateField(key, value);
    if (this.validationErrors[key]) return;
    await this.tryApply(key, value);
  };

  validateField = (fieldId: string, value: any): void => {
    const field = findField(fieldId);
    if (!field) return;

    const isOptional = field.optionalWhen
      ? evalCondition(field.optionalWhen, settingsState.currentSettings)
      : !!field.optional;

    if (!isOptional && (value === undefined || value === null || value === "")) {
      this.validationErrors = {
        ...this.validationErrors,
        [fieldId]: "This field is required",
      };
      return;
    }

    if (
      this.validationErrors[field.id] === "This field is required" &&
      (isOptional || (value !== "" && value !== undefined && value !== null))
    ) {
      const { [fieldId]: _, ...rest } = this.validationErrors;
      this.validationErrors = rest;
    }

    const regex = "regex" in field ? field.regex : undefined;
    if (!regex) return;

    const error = getValidationError(regex, value);
    if (error) {
      this.validationErrors = { ...this.validationErrors, [fieldId]: error };
    } else {
      const { [fieldId]: _, ...rest } = this.validationErrors;
      this.validationErrors = rest;
    }
  };

  resetToDefault = (fieldId: string): void => {
    const field = findField(fieldId);
    if (field) {
      void this.handleChange(fieldId, field.defaultValue);
    }
  };

  // Apply optimistically (like handleChange); the requirements popup reacts to
  // whatever the core then reports as missing.
  handlePresetSelect = async (fieldId: string, option: PresetOption): Promise<void> => {
    const updates: Record<string, any> = { [fieldId]: option.id };
    if (option.defaults) Object.assign(updates, option.defaults);
    await this.applyPresetUpdates(updates);
  };

  reEvaluateDeps = (...keys: string[]): void => {
    const deps = getConditionDeps();

    for (const key of keys) {
      const entries = deps.get(key);
      if (!entries) continue;

      for (const dep of entries) {
        if (dep.kind === "field" && dep.condition === "optionalWhen") {
          this.validateField(dep.fieldId, settingsState.currentSettings[dep.fieldId]);
        } else if (dep.kind === "section" && dep.condition === "expandWhen") {
          const sectionKey = `${dep.groupId}-${dep.sectionIndex}`;
          const group = SETTINGS_SCHEMA.find((g) => g.id === dep.groupId);
          const section = group?.sections[dep.sectionIndex];
          const expand =
            !!section && evalCondition(section.expandWhen, settingsState.currentSettings);
          this.onSectionExpand?.(sectionKey, expand);
        }
      }
    }
  };

  private async tryApply(key: string, value: any): Promise<void> {
    try {
      await this.applyFieldChange(key, value);
    } catch (e) {
      this.validationErrors = {
        ...this.validationErrors,
        [key]: errMessage(e),
      };
    }
  }

  private async applyFieldChange(key: string, value: any): Promise<void> {
    if (
      key.startsWith("llm.") &&
      key !== "llm.preset" &&
      !key.startsWith("llm.external.") &&
      getPresetFieldIds("llm").has(key)
    ) {
      if (settingsState.currentSettings["llm.preset"] !== "custom") {
        await settingsState.updateSetting("llm.preset", "custom");
      }
    }
    if (
      key.startsWith("stt.") &&
      key !== "stt.preset" &&
      !key.startsWith("stt.external.") &&
      getPresetFieldIds("stt").has(key)
    ) {
      if (settingsState.currentSettings["stt.preset"] !== "custom") {
        await settingsState.updateSetting("stt.preset", "custom");
      }
    }
    if (
      key.startsWith("prompts.") &&
      key !== "prompts.defaultSystemPrompt.preset" &&
      getPresetFieldIds("prompts").has(key)
    ) {
      if (settingsState.currentSettings["prompts.defaultSystemPrompt.preset"] !== "custom") {
        await settingsState.updateSetting("prompts.defaultSystemPrompt.preset", "custom");
      }
    }
    await settingsState.updateSetting(key, value);
    this.reEvaluateDeps(key);
  }

  private async applyPresetUpdates(updates: Record<string, any>): Promise<void> {
    await settingsState.updateSettings(updates);
    this.validateAllFields();
    this.reEvaluateDeps(...Object.keys(updates));
  }
}

export function useSettingsForm(
  onSectionExpand?: (sectionKey: string, expand: boolean) => void,
): SettingsForm {
  return new SettingsForm(onSectionExpand);
}
