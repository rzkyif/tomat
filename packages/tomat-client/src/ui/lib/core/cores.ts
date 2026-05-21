// Paired-cores registry. Backed by client settings (the {id, name, baseUrl}
// triples) + OS keychain (the bearer tokens). Owns the currently-selected
// core and rebuilds the CoreClient + its per-domain APIs on switch.

import { platform } from "../platform/index.ts";
import { BinariesApi } from "./binaries";
import { ChatApi } from "./chat";
import { CoreClient, type WsListener } from "./client";
import { LlmApi } from "./llm";
import { ModelsApi } from "./models";
import { PairingApi } from "./pairing";
import { CoreSettingsApi } from "./settings";
import { SessionsApi } from "./sessions";
import { SttApi } from "./stt";
import { ToolkitsApi } from "./toolkits";
import { TtsApi } from "./tts";

export interface PairedCoreEntry {
  id: string; // ULID returned by /pairing/claim
  name: string; // user-visible label
  baseUrl: string; // e.g. http://127.0.0.1:7800
  addedAtMs: number;
}

const CURRENT_KEY = "currentCoreId";

class CoresRegistry {
  private current: { entry: PairedCoreEntry; client: CoreClient } | null = null;
  private listeners = new Set<() => void>();
  private apis: {
    sessions: SessionsApi;
    chat: ChatApi;
    models: ModelsApi;
    binaries: BinariesApi;
    toolkits: ToolkitsApi;
    stt: SttApi;
    tts: TtsApi;
    llm: LlmApi;
    settings: CoreSettingsApi;
    pairing: PairingApi;
  } | null = null;

  // --- list / select -----------------------------------------------------

  async list(): Promise<PairedCoreEntry[]> {
    const s = await platform().clientSettings.read();
    const cores = (s.cores ?? []) as PairedCoreEntry[];
    return Array.isArray(cores) ? cores : [];
  }

  async addPaired(entry: PairedCoreEntry, token: string): Promise<void> {
    await platform().keychain.set(entry.id, token);
    const cores = await this.list();
    const updated = cores.filter((c) => c.id !== entry.id).concat(entry);
    await this.writeCores(updated, entry.id);
  }

  async removePaired(id: string): Promise<void> {
    await platform().keychain.delete(id);
    const cores = await this.list();
    const remaining = cores.filter((c) => c.id !== id);
    const nextCurrent = remaining[0]?.id;
    await this.writeCores(remaining, nextCurrent);
    if (this.current?.entry.id === id) {
      this.current.client.close();
      this.current = null;
      this.apis = null;
    }
    this.notify();
  }

  async select(id: string): Promise<void> {
    const cores = await this.list();
    const entry = cores.find((c) => c.id === id);
    if (!entry) throw new Error(`core ${id} not in paired list`);
    const token = await platform().keychain.get(entry.id);
    if (!token) throw new Error(`no token for core ${entry.id}; re-pair`);
    if (this.current) this.current.client.close();
    const client = new CoreClient({ baseUrl: entry.baseUrl, token });
    this.current = { entry, client };
    this.apis = {
      sessions: new SessionsApi(client),
      chat: new ChatApi(client),
      models: new ModelsApi(client),
      binaries: new BinariesApi(client),
      toolkits: new ToolkitsApi(client),
      stt: new SttApi(client),
      tts: new TtsApi(client),
      llm: new LlmApi(client),
      settings: new CoreSettingsApi(client),
      pairing: new PairingApi(client),
    };
    await this.writeCurrent(id);
    this.notify();
  }

  async restoreSelected(): Promise<void> {
    const s = await platform().clientSettings.read();
    const currentId = typeof s[CURRENT_KEY] === "string" ? (s[CURRENT_KEY] as string) : undefined;
    const cores = await this.list();
    const pick = currentId ? (cores.find((c) => c.id === currentId) ?? cores[0]) : cores[0];
    if (pick) {
      try {
        await this.select(pick.id);
      } catch {
        /* offline / unpaired */
      }
    }
  }

  currentEntry(): PairedCoreEntry | null {
    return this.current?.entry ?? null;
  }

  currentClient(): CoreClient | null {
    return this.current?.client ?? null;
  }

  api(): {
    sessions: SessionsApi;
    chat: ChatApi;
    models: ModelsApi;
    binaries: BinariesApi;
    toolkits: ToolkitsApi;
    stt: SttApi;
    tts: TtsApi;
    llm: LlmApi;
    settings: CoreSettingsApi;
    pairing: PairingApi;
  } {
    if (!this.apis) throw new Error("no core selected; call select() first");
    return this.apis;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeWs(listener: WsListener): () => void {
    const c = this.current?.client;
    if (!c)
      return () => {
        /* */
      };
    return c.subscribe(listener);
  }

  subscribeConnectionState(
    listener: (state: import("./client").ConnectionState) => void,
  ): () => void {
    const c = this.current?.client;
    if (!c)
      return () => {
        /* */
      };
    return c.onConnectionState(listener);
  }

  // --- internals ---------------------------------------------------------

  private async writeCores(cores: PairedCoreEntry[], current?: string): Promise<void> {
    const s = await platform().clientSettings.read();
    s.cores = cores;
    if (current) s[CURRENT_KEY] = current;
    await platform().clientSettings.write(s);
  }

  private async writeCurrent(id: string): Promise<void> {
    const s = await platform().clientSettings.read();
    s[CURRENT_KEY] = id;
    await platform().clientSettings.write(s);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* */
      }
    }
  }
}

let _instance: CoresRegistry | null = null;
export function cores(): CoresRegistry {
  if (!_instance) _instance = new CoresRegistry();
  return _instance;
}
