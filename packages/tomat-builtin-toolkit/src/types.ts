// Minimal local copy of the ToolContext shape the Tomat worker injects.
// Keeping this in-source means the toolkit has no compile-time dependency
// on a Tomat SDK package. The worker just calls the exported function
// with the structure described here. If the shape ever drifts, this file
// is the source of truth for what the built-in toolkit relies on.

export type AskUserQuestion = {
  question: string;
  options?: { label: string; description?: string; value: string }[];
  multiselect?: boolean;
  allowFreeformInput?: boolean;
};

export type AskUserAnswer = string | string[];

export interface ToolChatContext {
  userMessage: string;
  sessionId: string | null;
  locale?: string;
}

export interface ToolContext {
  setProgress(progress: number, label?: string, description?: string): void;
  askUser(questions: AskUserQuestion[]): Promise<AskUserAnswer[]>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  signal: AbortSignal;
  getChatContext(): ToolChatContext;
}
