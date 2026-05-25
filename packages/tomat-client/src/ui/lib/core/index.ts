// Barrel for the core-API client. Components/state import from here so we
// have one stable surface: `import { cores, ApiError } from "$lib/core";`

export { ApiError, CoreClient } from "./client";
export type { CoreEndpoint, WsListener } from "./client";

export { cores } from "./cores";
export type { PairedCoreEntry } from "./cores";

export { SessionsApi } from "./sessions";
export { ChatApi } from "./chat";
export { ModelsApi } from "./models";
export { BinariesApi } from "./binaries";
export { ToolkitsApi } from "./toolkits";
export { SttApi } from "./stt";
export { TtsApi } from "./tts";
export { CoreSettingsApi } from "./settings";
export { PairingApi } from "./pairing";
export { UpdateApi } from "./update";
