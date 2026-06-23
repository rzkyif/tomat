/**
 * The Quick Settings curation: which schema fields each accordion section
 * shows, in order. Every id resolves against SETTINGS_SCHEMA via findField()
 * and renders through the same SettingsField renderer as the full Settings
 * panel, so adding a setting here is just adding its id (manifest.test.ts
 * guards against schema drift).
 *
 * Keep at least one entry per section without a `visibleWhen`: the renderer
 * has no empty-body state, so a section whose every field is hidden would
 * open onto nothing.
 */

import type { FieldCondition } from "@tomat/shared";

export interface QuickSettingsFieldRef {
  /** A field id in SETTINGS_SCHEMA, resolved with findField(). */
  id: string;
  /** Quick-settings-only visibility, AND-ed with the field's own
   *  `visibleWhen` (which SettingsField evaluates itself). Needed where the
   *  full Settings hides a field via a SECTION-level condition (e.g. the
   *  External Provider sections), which doesn't exist here. */
  visibleWhen?: FieldCondition;
}

export interface QuickSettingsSectionDef {
  id: "general" | "stt" | "llm" | "tts" | "tools" | "greetings";
  title: string;
  /** Boolean schema field rendered as the on/off toggle in the section
   *  header. While off, the section is collapsed and not expandable. */
  enabledField?: string;
  fields: QuickSettingsFieldRef[];
}

export const QUICK_SETTINGS_SECTIONS: QuickSettingsSectionDef[] = [
  {
    id: "general",
    title: "General",
    fields: [
      { id: "appearance.theme" },
      { id: "appearance.textSize" },
      { id: "layout.alignment" },
      { id: "appearance.animationsEnabled" },
    ],
  },
  {
    id: "stt",
    title: "Speech-to-Text",
    enabledField: "stt.enabled",
    fields: [
      { id: "stt.provider" },
      { id: "stt.preset" },
      {
        id: "stt.external.baseUrl",
        visibleWhen: { field: "stt.provider", eq: "external" },
      },
      {
        id: "stt.external.apiKey",
        visibleWhen: { field: "stt.provider", eq: "external" },
      },
      {
        id: "stt.external.model",
        visibleWhen: { field: "stt.provider", eq: "external" },
      },
      { id: "stt.activation" },
      { id: "stt.holdDuration" },
      { id: "stt.llmAutocorrect" },
      { id: "stt.autoSend" },
    ],
  },
  {
    id: "llm",
    title: "Language Model",
    fields: [
      { id: "llm.provider" },
      { id: "llm.preset" },
      {
        id: "llm.external.baseUrl",
        visibleWhen: { field: "llm.provider", eq: "external" },
      },
      {
        id: "llm.external.apiKey",
        visibleWhen: { field: "llm.provider", eq: "external" },
      },
      {
        id: "llm.external.model",
        visibleWhen: { field: "llm.provider", eq: "external" },
      },
      { id: "llm.reasoning" },
      { id: "llm.showReasoning" },
    ],
  },
  {
    id: "tts",
    title: "Text-to-Speech",
    enabledField: "tts.enabled",
    fields: [
      { id: "tts.voice" },
      { id: "tts.synthesisSpeed" },
      {
        id: "tts.volume",
      },
    ],
  },
  {
    id: "tools",
    title: "Tools",
    enabledField: "tools.enabled",
    fields: [{ id: "tools.filteringEnabled" }, { id: "tools.maxHops" }],
  },
  {
    id: "greetings",
    title: "Greetings",
    enabledField: "greetings.enabled",
    fields: [
      { id: "greetings.runOn" },
      { id: "greetings.sessionTitle" },
      { id: "greetings.instruction" },
    ],
  },
];
