// REST request / response shapes for the /api/v1/* surface.
// Many bodies are inferred from validation schemas under ./../validation/;
// types unique to specific endpoints live here.

import type { Message, Session, SessionListEntry, TokenUsage } from "../domain/session.ts";
import type {
  Grant,
  OpenAIToolDef,
  PermissionDecl,
  Tool,
  ToolDescriptor,
  Toolkit,
  ToolkitSearchResult,
  ToolkitSource,
} from "../domain/toolkit.ts";
import type {
  BinaryKind,
  BinaryProbeResult,
  BinaryStatus,
  DownloadEntry,
  DownloadPlan,
  ModelEntry,
  RequirementsSnapshot,
  SidecarSnapshot,
} from "../domain/model.ts";
import type { StorageTree } from "../domain/storage.ts";

export const API_BASE = "/api/v1";

// --- Public ----------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  version: string;
  uptimeMs: number;
}

// --- Sessions --------------------------------------------------------------

export type ListSessionsResponse = SessionListEntry[];

export interface CreateSessionRequest {
  title?: string;
}
export type CreateSessionResponse = Session;

export interface GetSessionResponse extends Session {
  messages: Message[];
}

export interface PatchSessionRequest {
  title?: string;
}
export type PatchSessionResponse = Pick<Session, "id" | "title">;

export type AppendMessageRequest = Message;
export interface AppendMessageResponse {
  id: string;
  ord: number;
}

export type PatchMessageRequest = Partial<Message>;
export interface PatchMessageResponse {
  id: string;
  ord: number;
}

export interface UploadAttachmentResponse {
  id: string;
  absPath: string;
  filename: string;
}

// --- STT -------------------------------------------------------------------

export interface SttTranscribeResponse {
  text: string;
}

export interface SttStatusResponse {
  provider: "local" | "external";
  running: boolean;
}

// --- TTS -------------------------------------------------------------------

export interface TtsSynthesizeRequest {
  text: string;
  voice?: string;
  speed?: number;
}

export interface TtsVoiceEntry {
  id: string;
  label: string;
  lang?: string;
}
export type TtsVoicesResponse = TtsVoiceEntry[];

export interface TtsStatusResponse {
  loaded: boolean;
  loading: boolean;
}

// --- Models ----------------------------------------------------------------

export type ListModelsResponse = ModelEntry[];

export interface DownloadModelsRequest {
  items: Array<{ source: string; group?: "llm" | "stt" | "tts" | "embed" }>;
}
export interface DownloadModelsResponse {
  jobIds: string[];
}

export interface ProbeModelsRequest {
  sources: string[];
}
export type ProbeModelsResponse = DownloadPlan[];

export type ListDownloadsResponse = DownloadEntry[];

// --- Binaries --------------------------------------------------------------

export type ListBinariesResponse = BinaryStatus[];

export interface InstallBinariesRequest {
  kinds?: BinaryKind[];
}
export interface InstallBinariesResponse {
  jobIds: string[];
}

export interface UpdateBinaryRequest {
  kind: BinaryKind;
}
export interface UpdateBinaryResponse {
  jobId: string;
}

export interface BinaryUpdateCheck {
  kind: BinaryKind;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string;
  available: boolean;
}
export type CheckBinariesResponse = BinaryUpdateCheck[];

export interface ProbeBinariesRequest {
  kinds: BinaryKind[];
}
export type ProbeBinariesResponse = BinaryProbeResult[];

// --- Requirements ----------------------------------------------------------

export type GetRequirementsResponse = RequirementsSnapshot;
export interface DownloadRequirementsResponse {
  modelJobIds: string[];
  binaryJobIds: string[];
}

// --- Storage ---------------------------------------------------------------

export type GetStorageResponse = StorageTree;
export interface DeleteStoragePathsRequest {
  paths: string[];
}

// --- Core self-update ------------------------------------------------------

export interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  manifestUrl: string;
}

export interface UpdateApplyRequest {
  version?: string;
}

// --- Toolkits --------------------------------------------------------------

export type ListToolkitsResponse = Toolkit[];

export interface SearchToolkitsResponse {
  results: ToolkitSearchResult[];
}

// Acquire a toolkit's files (POST /download): fetch + extract an npm tarball,
// copy the built-in, or register a locally dropped-in folder. Deps are NOT
// installed here; that is the separate POST /:id/install step.
export type DownloadToolkitRequest =
  | { source: "npm"; name: string; version?: string }
  | { source: "local"; path: string; slug?: string }
  | { source: "builtin" };

// Returned by every endpoint that starts a streamed background job (download,
// install-deps, update). Progress + completion arrive over the
// toolkit.install_log / toolkit.install_done WS frames, keyed by `jobId`.
export interface ToolkitJobResponse {
  jobId: string;
  toolkitId: string;
}

// Returned by the synchronous toolkit actions: enable-all / disable-all /
// confirm-reenable.
export interface ToolkitActionResponse {
  id: string;
}

export interface UpdateToolkitRequest {
  version?: string;
}

export interface ListToolkitToolsResponse {
  tools: Tool[];
}

// Check installed toolkits for newer versions. With no `ids`, every installed
// toolkit is checked. npm toolkits resolve `dist-tags.latest`; the built-in
// resolves its signed manifest version; local toolkits have no upstream and
// report `latestVersion: null`.
export interface CheckUpdatesRequest {
  ids?: string[];
}
export interface ToolkitUpdateStatus {
  id: string;
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error?: string;
}
export interface CheckUpdatesResponse {
  results: ToolkitUpdateStatus[];
}

export interface SetGrantsRequest {
  grants: Array<{ key: string; state: Grant["state"] }>;
}
export interface SetGrantsResponse {
  grants: Grant[];
}

export interface ToolFilterRequest {
  vector: number[];
  topK?: number;
}
export interface ToolFilterResponse {
  candidates: ToolDescriptor[];
}

export interface ToolSchemasRequest {
  ids: string[];
}
export interface ToolSchemasResponse {
  tools: OpenAIToolDef[];
}

export interface EmbedRequest {
  texts: string[];
}
export interface EmbedResponse {
  vectors: number[][];
}

// --- LLM utility (single-shot) --------------------------------------------

export interface AutocorrectRequest {
  text: string;
}
export interface AutocorrectResponse {
  text: string;
}

export interface MergeTranscriptionRequest {
  existing: string;
  next: string;
}
export interface MergeTranscriptionResponse {
  text: string;
}

// --- Settings --------------------------------------------------------------

// CoreSettings shape is sparse (only non-defaults persisted).
// Concrete field definitions live in domain/settings.ts (added in a later
// milestone). The wire format is just a record.
export type GetCoreSettingsResponse = Record<string, unknown>;
export type PatchCoreSettingsRequest = Record<string, unknown>;
export type PatchCoreSettingsResponse = Record<string, unknown>;

// --- Update ----------------------------------------------------------------

export interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  manifestUrl: string;
}

export interface UpdateApplyRequest {
  version?: string;
}

// --- Sidecars --------------------------------------------------------------

/** Live resource sample for a single process. */
export interface ProcessMetricsLite {
  pid: number;
  rssMb: number;
  cpuPct: number;
}

/** Response of GET /api/v1/sidecars/status. The route samples only its own
 *  tracked processes (sidecar PIDs + the core process); it never accepts a PID
 *  from the caller. `sidecars` carries llama/whisper (and tts when loaded) with
 *  `rssMb`/`cpuPct` populated; `core` is the core process itself. */
export interface SidecarsStatusResponse {
  sidecars: SidecarSnapshot[];
  core: ProcessMetricsLite;
}

// --- Helpers shared by clients --------------------------------------------

// Re-export commonly needed enums so client code can import everything from
// one entry without crossing into `domain/*`.
export type { PermissionDecl, TokenUsage, ToolkitSource };
