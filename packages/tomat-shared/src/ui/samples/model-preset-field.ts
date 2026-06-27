import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type ModelPresetFieldView from "../components/settings/ModelPresetFieldView.svelte";

export const modelPresetFieldSamples = {
  recommended: {
    checkLabel: "Check for Newer Models",
    checkIcon: "i-material-symbols-refresh-rounded",
    buckets: [
      {
        id: "balanced",
        title: "Balanced",
        description: "A capable model tuned to fit comfortably on this device.",
        selected: true,
        selectable: true,
        badges: [
          { icon: "i-material-symbols-psychology-alt-rounded", text: "Qwen2.5 7B" },
          { icon: "i-material-symbols-memory-rounded", text: "4.7 GB" },
          { icon: "i-material-symbols-bolt-rounded", text: "Q4_K_M" },
        ],
      },
      {
        id: "quality",
        title: "Quality",
        description: "The strongest model that still fits this device.",
        selected: false,
        selectable: true,
        badges: [
          { icon: "i-material-symbols-psychology-alt-rounded", text: "Qwen2.5 14B" },
          { icon: "i-material-symbols-memory-rounded", text: "9.0 GB" },
          { icon: "i-material-symbols-bolt-rounded", text: "Q5_K_M" },
        ],
      },
    ],
    custom: {
      title: "Custom",
      description: "Pick any catalog model and quantization yourself.",
      selected: false,
      model: {
        value: "qwen2.5-7b",
        options: [
          { value: "qwen2.5-7b", label: "Qwen2.5 7B · 4.4-8.1 GB" },
          { value: "qwen2.5-14b", label: "Qwen2.5 14B · 9.0-15.7 GB" },
          { value: "__manual__", label: "Manual Configuration" },
        ],
      },
      quant: {
        value: "qwen2.5-7b-q4_k_m",
        options: [
          { value: "qwen2.5-7b-q4_k_m", label: "Q4_K_M · 4.7 GB · recommended" },
          { value: "qwen2.5-7b-q8_0", label: "Q8_0 · 8.1 GB" },
        ],
      },
    },
  },
  checking: {
    checkLabel: "Checking…",
    checkIcon: "i-line-md:loading-loop",
    checkDisabled: true,
    buckets: [
      {
        id: "balanced",
        title: "Balanced",
        description: "A capable model tuned to fit comfortably on this device.",
        selected: false,
        selectable: false,
        badges: null,
        placeholder: "Computing for your device…",
      },
    ],
  },
  betterAvailable: {
    checkLabel: "Newer Models Found",
    checkIcon: "i-material-symbols-auto-awesome-rounded",
    buckets: [
      {
        id: "balanced",
        title: "Balanced",
        description: "A capable model tuned to fit comfortably on this device.",
        selected: true,
        selectable: true,
        badges: [
          { icon: "i-material-symbols-psychology-alt-rounded", text: "Qwen2.5 7B" },
          { icon: "i-material-symbols-memory-rounded", text: "4.7 GB" },
          { icon: "i-material-symbols-bolt-rounded", text: "Q4_K_M" },
        ],
        better: {
          message: "A better model is available for Balanced: Qwen3 8B",
          applying: false,
          onApply: () => {},
          onDismiss: () => {},
        },
      },
    ],
    custom: {
      title: "Custom",
      selected: false,
      model: {
        value: "__manual__",
        options: [
          { value: "qwen2.5-7b", label: "Qwen2.5 7B · 4.4-8.1 GB" },
          { value: "qwen2.5-72b", label: "Qwen2.5 72B · 47.4 GB · won't fit", disabled: true },
          { value: "__manual__", label: "Manual Configuration" },
        ],
      },
      quant: null,
    },
  },
  error: {
    error: "Could not reach the Core.",
    checkLabel: "Check for Newer Models",
    checkIcon: "i-material-symbols-refresh-rounded",
    buckets: [],
  },
  noCustom: {
    checkLabel: "Check for Newer Models",
    checkIcon: "i-material-symbols-refresh-rounded",
    buckets: [
      {
        id: "balanced",
        title: "Balanced",
        description: "A capable model tuned to fit comfortably on this device.",
        selected: true,
        selectable: true,
        badges: [
          { icon: "i-material-symbols-psychology-alt-rounded", text: "Qwen2.5 7B" },
          { icon: "i-material-symbols-memory-rounded", text: "4.7 GB" },
          { icon: "i-material-symbols-bolt-rounded", text: "Q4_K_M" },
        ],
      },
    ],
    custom: null,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof ModelPresetFieldView>>>;
