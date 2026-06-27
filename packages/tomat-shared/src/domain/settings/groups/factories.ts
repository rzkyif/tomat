/**
 * Shared builders for repeated settings structures, so the group data files
 * stay declarative without copy-pasting near-identical field blocks.
 */

import type { FieldCondition, SettingField, SettingSection } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export interface ExternalModelSectionOpts {
  /** Prefix for the field ids; produces `${idPrefix}.baseUrl`, `.apiKey`,
   *  `.model`, and (when opted in) `.contextSize` / `.voice`. */
  idPrefix: string;
  label: string;
  visibleWhen: FieldCondition;
  baseUrlDescription: string;
  apiKeyDescription: string;
  model: { description: string; placeholder: string };
  /** Add a "Context Window" number field (the LLM-style providers track usage
   *  against it). */
  contextSize?: boolean;
  /** Add a "Voice" field (text-to-speech providers name a voice). */
  voice?: boolean;
}

/** The "External Provider" section every external-model group shares: an HTTPS
 *  base URL, a vault-stored API key, and a model name, plus optional context
 *  window / voice fields. Always persisted to the core. */
export function externalModelSection(opts: ExternalModelSectionOpts): SettingSection {
  const fields: SettingField[] = [
    {
      id: `${opts.idPrefix}.baseUrl`,
      name: "Base URL",
      description: opts.baseUrlDescription,
      type: "string",
      defaultValue: "",
      placeholder: "https://api.example.com/v1",
      regex: SECURE_URL_VALIDATION,
      descriptionTier: "ondemand",
    },
    {
      id: `${opts.idPrefix}.apiKey`,
      name: "API Key",
      description: opts.apiKeyDescription,
      type: "password",
      defaultValue: "",
      placeholder: "sk-...",
      descriptionTier: "ondemand",
    },
    {
      id: `${opts.idPrefix}.model`,
      name: "Model",
      description: opts.model.description,
      type: "string",
      defaultValue: "",
      placeholder: opts.model.placeholder,
      descriptionTier: "ondemand",
    },
  ];
  if (opts.contextSize) {
    fields.push({
      id: `${opts.idPrefix}.contextSize`,
      name: "Context Window",
      description: "The model's context window, in tokens. Used to track usage.",
      type: "number",
      defaultValue: 128000,
      descriptionTier: "ondemand",
    });
  }
  if (opts.voice) {
    fields.push({
      id: `${opts.idPrefix}.voice`,
      name: "Voice",
      description: "The voice name the external model should use, e.g. alloy.",
      type: "string",
      defaultValue: "alloy",
      placeholder: "alloy",
      descriptionTier: "ondemand",
    });
  }
  return {
    label: opts.label,
    destination: "core",
    visibleWhen: opts.visibleWhen,
    fields,
  };
}
