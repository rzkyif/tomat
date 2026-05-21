/**
 * Defines the snippet shape and the logic that expands `@trigger` tokens
 * inside the user's input. Validates triggers, walks the raw text to
 * substitute matching snippets, and returns the final text along with any
 * system-prompt overrides the snippets ask for.
 */

export type SnippetPlacement =
  | "prepend-system"
  | "replace-system"
  | "append-system"
  | "prepend-user"
  | "replace-user"
  | "insert-user"
  | "append-user";

export type Snippet = {
  id: string;
  name: string;
  trigger: string;
  placement: SnippetPlacement;
  text: string;
};

export type SnippetOverride = {
  prepend?: string;
  replace?: string;
  append?: string;
};

export type SnippetApplyResult = {
  userText: string;
  systemOverride?: SnippetOverride;
};

export const SNIPPET_PLACEMENT_OPTIONS: {
  value: SnippetPlacement;
  label: string;
}[] = [
  { value: "prepend-system", label: "Prepend System Prompt" },
  { value: "replace-system", label: "Replace System Prompt" },
  { value: "append-system", label: "Append System Prompt" },
  { value: "prepend-user", label: "Prepend User Prompt" },
  { value: "replace-user", label: "Replace User Prompt" },
  { value: "insert-user", label: "Insert in User Prompt" },
  { value: "append-user", label: "Append User Prompt" },
];

// Matches `@word` only when preceded by start-of-string or a non-word char
// other than `@`. Prevents `email@domain` from being read as a trigger while
// allowing `(hello @foo)`.
const TRIGGER_SCAN = /(^|[^\w@])(@[A-Za-z0-9_-]+)/g;

// Stricter variant for the autocomplete text-before-caret scan.
export const TRIGGER_BEFORE_CARET = /(?:^|[^\w@])(@[\w-]*)$/;

export function normalizeTrigger(raw: string): string {
  const stripped = raw.replace(/^@+/, "").replace(/\s+/g, "");
  return stripped ? `@${stripped}` : "";
}

export function validateTrigger(trigger: string, existingTriggers: string[]): string | null {
  if (!trigger) return "Trigger is required";
  if (!trigger.startsWith("@")) return "Trigger must start with @";
  if (!/^@[A-Za-z0-9_-]+$/.test(trigger)) {
    return "Only letters, numbers, underscore, and dash are allowed";
  }
  if (existingTriggers.includes(trigger)) {
    return "This trigger is already used by another snippet";
  }
  return null;
}

/**
 * Walk the raw user text left-to-right, expanding snippet triggers according
 * to their placement. Tokens that don't resolve to any known snippet are left
 * in place (so a stray `@foo` from the user still ends up in the sent text).
 *
 * Composition rules (mirror the plan):
 *  - prepend-user / append-user / insert-user modify the user text in place.
 *  - prepend-system / append-system accumulate into the override, joined by
 *    "\n\n" in trigger-appearance order.
 *  - replace-user and replace-system are last-wins: every replace encountered
 *    overwrites the previous value, so the final result matches "simulate
 *    every replace in left-to-right order".
 */
export function applySnippets(raw: string, snippets: Snippet[]): SnippetApplyResult {
  if (!raw || snippets.length === 0) {
    return { userText: raw };
  }

  const byTrigger = new Map<string, Snippet>();
  for (const s of snippets) {
    if (s.trigger) byTrigger.set(s.trigger.toLowerCase(), s);
  }
  if (byTrigger.size === 0) return { userText: raw };

  const prependUserParts: string[] = [];
  const appendUserParts: string[] = [];
  let replaceUserValue: string | null = null;
  let anyReplaceUser = false;

  const prependSystemParts: string[] = [];
  const appendSystemParts: string[] = [];
  let replaceSystemValue: string | null = null;
  let hasSystemOverride = false;

  let inlinedText = "";
  let cursor = 0;
  TRIGGER_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRIGGER_SCAN.exec(raw)) !== null) {
    const leading = match[1];
    const token = match[2];
    const snippet = byTrigger.get(token.toLowerCase());

    // Everything up to and including the boundary char is kept verbatim.
    const boundaryEnd = match.index + leading.length;
    inlinedText += raw.slice(cursor, boundaryEnd);

    if (!snippet) {
      // Unknown trigger: leave the @token as-is.
      inlinedText += token;
      cursor = boundaryEnd + token.length;
      continue;
    }

    switch (snippet.placement) {
      case "insert-user":
        inlinedText += snippet.text;
        break;
      case "prepend-user":
        prependUserParts.push(snippet.text);
        break;
      case "append-user":
        appendUserParts.push(snippet.text);
        break;
      case "replace-user":
        anyReplaceUser = true;
        replaceUserValue = snippet.text;
        break;
      case "prepend-system":
        prependSystemParts.push(snippet.text);
        hasSystemOverride = true;
        break;
      case "append-system":
        appendSystemParts.push(snippet.text);
        hasSystemOverride = true;
        break;
      case "replace-system":
        replaceSystemValue = snippet.text;
        hasSystemOverride = true;
        break;
    }

    cursor = boundaryEnd + token.length;
  }
  inlinedText += raw.slice(cursor);

  let userText: string;
  if (anyReplaceUser) {
    userText = replaceUserValue ?? "";
  } else {
    const middle = inlinedText.trim();
    const parts: string[] = [];
    if (prependUserParts.length) parts.push(prependUserParts.join("\n\n"));
    if (middle) parts.push(middle);
    if (appendUserParts.length) parts.push(appendUserParts.join("\n\n"));
    userText = parts.join("\n\n");
  }

  const systemOverride: SnippetOverride | undefined = hasSystemOverride
    ? {
        ...(prependSystemParts.length ? { prepend: prependSystemParts.join("\n\n") } : {}),
        ...(replaceSystemValue !== null ? { replace: replaceSystemValue } : {}),
        ...(appendSystemParts.length ? { append: appendSystemParts.join("\n\n") } : {}),
      }
    : undefined;

  return { userText, systemOverride };
}
