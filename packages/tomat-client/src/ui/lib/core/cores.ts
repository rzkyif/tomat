// Paired-cores registry. Backed by client settings (the {id, name, baseUrl}
// triples) + OS keychain (the bearer tokens). Owns the currently-selected
// core and rebuilds the CoreClient + its per-domain APIs on switch.

import { platform } from "../platform/index.ts";
import { getLogger } from "$lib/shared/log";
import { Subscribers } from "../shared/subscribers.ts";
import { BinariesApi } from "./binaries";
import { ChatApi } from "./chat";
import { CoreClient, type ConnectionListener, type WsListener } from "./client";
import { LlmApi } from "./llm";
import { ModelsApi } from "./models";
import { RequirementsApi } from "./requirements";
import { StorageApi } from "./storage";
import { PairingApi } from "./pairing";
import { CoreSettingsApi } from "./settings";
import { SessionsApi } from "./sessions";
import { SttApi } from "./stt";
import { ToolkitsApi } from "./toolkits";
import { TtsApi } from "./tts";
import { UpdateApi } from "./update";

const log = getLogger("cores");

export interface PairedCoreEntry {
  id: string; // ULID returned by pairing
  name: string; // user-visible label
  baseUrl: string; // e.g. https://127.0.0.1:7800
  tlsPin: string; // pinned cert SPKI (base64 SHA-256), captured at pairing
  addedAtMs: number;
}

const CURRENT_KEY = "currentCoreId";

class CoresRegistry {
  private current: { entry: PairedCoreEntry; client: CoreClient } | null = null;
  private listeners = new Subscribers<() => void>();
  // Persistent WS / connection-state listeners. These survive core switches:
  // subscribeWs / subscribeConnectionState add to these sets, and select()
  // re-binds every one onto the freshly-built client. Without this, a listener
  // registered while no core was paired (or before a switch) would be bound to
  // a dead/closed client and silently stop receiving frames. The *Bindings
  // maps hold each listener's unsubscribe handle for the CURRENT client only.
  private wsListeners = new Set<WsListener>();
  private wsBindings = new Map<WsListener, () => void>();
  private connListeners = new Set<ConnectionListener>();
  private connBindings = new Map<ConnectionListener, () => void>();
  private apis: {
    sessions: SessionsApi;
    chat: ChatApi;
    models: ModelsApi;
    binaries: BinariesApi;
    requirements: RequirementsApi;
    storage: StorageApi;
    toolkits: ToolkitsApi;
    stt: SttApi;
    tts: TtsApi;
    llm: LlmApi;
    settings: CoreSettingsApi;
    pairing: PairingApi;
    update: UpdateApi;
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
      // The closed client's subscriptions are dead; the persistent listener
      // sets stay intact so a later select() re-binds them.
      this.wsBindings.clear();
      this.connBindings.clear();
    }
    this.notify();
  }

  /** Rename a paired core in place. Preserves the current-core pointer and
   *  keeps the in-memory active entry's name in sync. */
  async rename(id: string, name: string): Promise<void> {
    const s = await platform().clientSettings.read();
    const list = (Array.isArray(s.cores) ? s.cores : []) as PairedCoreEntry[];
    if (!list.some((c) => c.id === id)) return;
    s.cores = list.map((c) => (c.id === id ? { ...c, name } : c));
    await platform().clientSettings.write(s);
    if (this.current?.entry.id === id) {
      this.current = { ...this.current, entry: { ...this.current.entry, name } };
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
    const client = new CoreClient({
      baseUrl: entry.baseUrl,
      token,
      tlsPin: entry.tlsPin,
    });
    this.current = { entry, client };
    this.apis = {
      sessions: new SessionsApi(client),
      chat: new ChatApi(client),
      models: new ModelsApi(client),
      binaries: new BinariesApi(client),
      requirements: new RequirementsApi(client),
      storage: new StorageApi(client),
      toolkits: new ToolkitsApi(client),
      stt: new SttApi(client),
      tts: new TtsApi(client),
      llm: new LlmApi(client),
      settings: new CoreSettingsApi(client),
      pairing: new PairingApi(client),
      update: new UpdateApi(client),
    };
    this.rebindListeners(client);
    await this.writeCurrent(id);
    this.notify();
  }

  /** Re-subscribe every persistent WS / connection-state listener onto a
   *  freshly-built client. The previous client was closed by `select()`, so
   *  its subscriptions are already dead, so drop the stale handles and rebind. */
  private rebindListeners(client: CoreClient): void {
    this.wsBindings.clear();
    this.connBindings.clear();
    for (const l of this.wsListeners) {
      this.wsBindings.set(l, client.subscribe(l));
    }
    for (const l of this.connListeners) {
      this.connBindings.set(l, client.onConnectionState(l));
    }
  }

  async restoreSelected(): Promise<void> {
    const s = await platform().clientSettings.read();
    const currentId = typeof s[CURRENT_KEY] === "string" ? (s[CURRENT_KEY] as string) : undefined;
    const cores = await this.list();
    const pick = currentId ? (cores.find((c) => c.id === currentId) ?? cores[0]) : cores[0];
    if (pick) {
      try {
        await this.select(pick.id);
      } catch (e) {
        // Don't abort boot. The window is already up and the chat view renders
        // with the reconnect banner. But make the failure visible (keychain
        // miss, missing token, etc.) instead of swallowing it silently.
        log.error("restoreSelected: select failed:", e);
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
    requirements: RequirementsApi;
    storage: StorageApi;
    toolkits: ToolkitsApi;
    stt: SttApi;
    tts: TtsApi;
    llm: LlmApi;
    settings: CoreSettingsApi;
    pairing: PairingApi;
    update: UpdateApi;
  } {
    if (!this.apis) throw new Error("no core selected; call select() first");
    return this.apis;
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  subscribeWs(listener: WsListener): () => void {
    this.wsListeners.add(listener);
    const c = this.current?.client;
    if (c) this.wsBindings.set(listener, c.subscribe(listener));
    return () => {
      this.wsListeners.delete(listener);
      this.wsBindings.get(listener)?.();
      this.wsBindings.delete(listener);
    };
  }

  subscribeConnectionState(listener: ConnectionListener): () => void {
    this.connListeners.add(listener);
    const c = this.current?.client;
    if (c) this.connBindings.set(listener, c.onConnectionState(listener));
    return () => {
      this.connListeners.delete(listener);
      this.connBindings.get(listener)?.();
      this.connBindings.delete(listener);
    };
  }

  // --- internals ---------------------------------------------------------

  private async writeCores(cores: PairedCoreEntry[], current?: string): Promise<void> {
    const s = await platform().clientSettings.read();
    s.cores = cores;
    if (current) {
      s[CURRENT_KEY] = current;
    } else {
      // Last core removed (or transition through no-current): drop the key so
      // the next restoreSelected() doesn't search for a ghost id.
      delete s[CURRENT_KEY];
    }
    await platform().clientSettings.write(s);
  }

  private async writeCurrent(id: string): Promise<void> {
    const s = await platform().clientSettings.read();
    s[CURRENT_KEY] = id;
    await platform().clientSettings.write(s);
  }

  private notify(): void {
    this.listeners.emit();
  }
}

let _instance: CoresRegistry | null = null;
export function cores(): CoresRegistry {
  if (!_instance) _instance = new CoresRegistry();
  return _instance;
}
