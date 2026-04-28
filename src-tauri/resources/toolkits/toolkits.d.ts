// Tomat Toolkit Author API.
//
// This file is types only - no runtime code. It is shipped alongside your
// toolkit as `~/.tomat/toolkits/toolkits.d.ts` so your editor can give
// autocomplete on METADATA and the tool function signatures.
//
// A toolkit is either:
//   - a single `.ts` file, or
//   - a folder containing `index.ts` (plus optional `package.json` + deps).
//
// It must `export const METADATA: ToolkitMetadata` and one named async
// function per tool (the name is given by `ToolDefinition.function`).

/** JSON Schema (draft 2020-12) for a tool's `parameters` field. */
export type ToolParameterSchema = Record<string, unknown>;

export interface ToolDefinition {
  /** Machine name. Must be unique within the toolkit. Used as the OpenAI
   *  `tools[].function.name` the model sees. Recommended pattern:
   *  lowercase snake_case, e.g. `open_website`. */
  name: string;
  /** One-sentence human description. Shown to the LLM in the tool list and
   *  embedded (alongside `triggers`) for the RAG relevance pass. */
  description: string;
  /** JSON Schema for the `function.parameters` field. The LLM is asked to
   *  produce an `arguments` object that satisfies this schema. */
  parameters: ToolParameterSchema;
  /** Example user prompts that should route to this tool. Concatenated with
   *  the description into the embedding used for phase-1 relevance filtering. */
  triggers: string[];
  /** Name of the async export on the toolkit module that runs this tool.
   *  Called as `fn(args, ctx)`. */
  function: string;
}

export interface ToolkitMetadata {
  /** Human-readable toolkit name. Shown in Settings > Toolkits. */
  name: string;
  /** One-paragraph description of what the toolkit does. */
  description: string;
  /** The tools this toolkit exposes. */
  tools: ToolDefinition[];
}

// --- Tool context (passed as 2nd arg to every tool function) ---

export type AskUserQuestion = {
  /** The question text rendered above the input. */
  question: string;
  /** When set, renders as a button list (or checkbox list if multiselect). */
  options?: { label: string; description?: string; value: string }[];
  /** Allow the user to pick more than one option. Default false. */
  multiselect?: boolean;
  /** When true, a free-text input is shown alongside the option buttons. */
  allowFreeformInput?: boolean;
};

/** Answer shape:
 *  - text / freeform: the string the user typed
 *  - single-select: the `value` of the chosen option
 *  - multiselect: array of chosen option values (plus any freeform text as
 *    the last element if `allowFreeformInput` was set and the user typed
 *    something in addition).
 */
export type AskUserAnswer = string | string[];

export interface ToolChatContext {
  userMessage: string;
  sessionId: string | null;
  locale?: string;
}

export interface ToolContext {
  /** Update the running tool-call bubble. `progress` is clamped to [0, 1].
   *  All args are optional; pass just the ones you want to change. */
  setProgress(progress: number, label?: string, description?: string): void;

  /** Ask the user one or more questions and await the reply. Resolves once
   *  the user submits the form. Rejects if the user cancels the tool call. */
  askUser(questions: AskUserQuestion[]): Promise<AskUserAnswer[]>;

  /** Append a log line visible in the bubble's "Details" disclosure. */
  log(level: "debug" | "info" | "warn" | "error", message: string): void;

  /** Fires when the user cancels this tool call or aborts the whole turn.
   *  Long-running tools should observe this and bail out. */
  signal: AbortSignal;

  /** Read-only snapshot of the turn that triggered this call. */
  getChatContext(): ToolChatContext;
}

/** The shape every tool function must match. */
export type ToolFunction = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
