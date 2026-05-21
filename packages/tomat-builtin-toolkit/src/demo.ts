// Walk through every variant of the askUser flow: free-text input,
// single-select buttons, and multiselect-with-freeform. Useful for verifying
// the askUser UI end-to-end and as a reference for toolkit authors.

import type { ToolContext } from "./types.ts";

export async function demo(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{
  name: string;
  color: string;
  preferences: string[];
}> {
  ctx.setProgress(0, "Starting demo");

  const [rawName] = await ctx.askUser([
    { question: "What's your name?" },
  ]);
  const name = typeof rawName === "string" ? rawName.trim() : "";
  ctx.setProgress(0.33, "Got name", name || "(empty)");

  const [rawColor] = await ctx.askUser([
    {
      question: "Pick your favorite color.",
      options: [
        { label: "Red", value: "red", description: "warm, attention-grabbing" },
        { label: "Blue", value: "blue", description: "calm, classic" },
        { label: "Green", value: "green", description: "natural, fresh" },
      ],
    },
  ]);
  const color = typeof rawColor === "string" ? rawColor : "";
  ctx.setProgress(0.66, "Got color", color);

  const [rawPrefs] = await ctx.askUser([
    {
      question: "Which of these do you enjoy? (pick any, add your own)",
      options: [
        { label: "Reading", value: "reading" },
        { label: "Gaming", value: "gaming" },
        { label: "Cooking", value: "cooking" },
        { label: "Hiking", value: "hiking" },
      ],
      multiselect: true,
      allowFreeformInput: true,
    },
  ]);
  const preferences = Array.isArray(rawPrefs) ? rawPrefs : [];
  ctx.setProgress(1, "Done", `${preferences.length} preferences recorded`);

  return { name, color, preferences };
}
