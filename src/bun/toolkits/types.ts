// Internal type definitions shared across the toolkits module.
// NOTE: mirrors the author-facing shapes in sdk/toolkits.d.ts but lives
// separately so worker / registry code has concrete runtime types.

export type ToolkitKind = "file" | "folder";

export type AskUserQuestion = {
  question: string;
  options?: { label: string; description?: string; value: string }[];
  multiselect?: boolean;
  allowFreeformInput?: boolean;
};

export type AskUserAnswer = string | string[];

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  triggers: string[];
  function: string;
}

export interface ToolkitMetadata {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

export interface ToolkitRow {
  id: string;
  kind: ToolkitKind;
  entryPath: string;
  displayName: string | null;
  description: string | null;
  trusted: boolean;
  depsInstalled: boolean;
  hasPackage: boolean;
  enabled: boolean;
  lastError: string | null;
  tools: ToolRow[];
  /** Count of tools in this toolkit that currently have an embedding row.
   *  Equal to tools.length when the toolkit is fully indexed; less than
   *  tools.length while indexing is in progress (e.g. the embedding model
   *  was unavailable when `enable` ran and the backfill hasn't caught up
   *  yet). The UI uses this to show "Indexing N/M" instead of misleading
   *  the user with "Enabled" before phase-1 vector search will work. */
  embeddedToolCount: number;
}

export interface ToolRow {
  id: string;
  toolkitId: string;
  name: string;
  description: string;
  triggers: string[];
  parameters: Record<string, unknown>;
  fnExport: string;
}

export interface UntrustedRow {
  id: string;
  kind: ToolkitKind;
  entryPath: string;
  hasPackage: boolean;
}

export interface ScanResult {
  trusted: ToolkitRow[];
  untrusted: UntrustedRow[];
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolDescriptor {
  /** tools.id (toolkitId:name). */
  id: string;
  toolkitId: string;
  name: string;
  description: string;
  score: number;
}

// WS frames

export type HostToClientFrame =
  | {
      kind: "progress";
      callId: string;
      progress: number;
      label?: string;
      description?: string;
    }
  | {
      kind: "ask_user_request";
      callId: string;
      requestId: string;
      questions: AskUserQuestion[];
    }
  | {
      kind: "log";
      callId: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
    }
  | { kind: "tool_result"; callId: string; result: unknown }
  | { kind: "tool_error"; callId: string; error: string }
  | { kind: "tool_cancelled"; callId: string }
  | { kind: "install_log"; id: string; stream: "stdout" | "stderr"; line: string }
  | { kind: "install_done"; id: string; ok: boolean; code: number };

export type ClientToHostFrame =
  | {
      kind: "start";
      callId: string;
      toolkitId: string;
      toolName: string;
      arguments: string;
      chatContext?: { userMessage: string; sessionId: string | null; locale?: string };
    }
  | {
      kind: "ask_user_response";
      callId: string;
      requestId: string;
      answers: AskUserAnswer[];
    }
  | { kind: "cancel"; callId: string };

// Worker <-> pool frames (in-process MessagePort)

export type PoolToWorkerFrame =
  | {
      kind: "boot";
      toolkitId: string;
      entryPath: string;
    }
  | {
      kind: "call";
      callId: string;
      toolName: string;
      fnExport: string;
      arguments: string;
      chatContext: { userMessage: string; sessionId: string | null; locale?: string };
    }
  | { kind: "cancel"; callId: string }
  | {
      kind: "ask_user_response";
      callId: string;
      requestId: string;
      answers: AskUserAnswer[];
    }
  | { kind: "shutdown" };

export type WorkerToPoolFrame =
  | { kind: "booted"; toolkitId: string; metadata: ToolkitMetadata }
  | {
      kind: "boot_failed";
      toolkitId: string;
      error: string;
    }
  | {
      kind: "progress";
      callId: string;
      progress: number;
      label?: string;
      description?: string;
    }
  | {
      kind: "ask_user_request";
      callId: string;
      requestId: string;
      questions: AskUserQuestion[];
    }
  | {
      kind: "log";
      callId: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
    }
  | { kind: "tool_result"; callId: string; result: unknown }
  | { kind: "tool_error"; callId: string; error: string };
