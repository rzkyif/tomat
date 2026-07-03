// The engine's public entry. `init(host)` builds and wires the portable service
// graph on a runtime-agnostic Host and returns an EngineInstance the embedder
// drives: the Deno shell (`@tomat/core`) wraps handleHttp / connect in
// Deno.serve + Deno.upgradeWebSocket; a future mobile client drives them in
// process. This is the Phase-1 skeleton: it holds the host and a FrameBus and
// stubs handleHttp; the DB, services, and routes move in over later phases.

import type { Host } from "./host.ts";
import { FrameBus } from "./frame-bus.ts";

// A single in-process client connection to the engine, mirroring the client's
// NetSocket contract. Frames are the JSON-encoded @tomat/shared frame unions.
export interface EngineConnection {
  // Client -> engine (chat.start, tool.* responses, ...).
  send(frameJson: string): void;
  // Engine -> client frames; returns a detach.
  subscribe(cb: (frameJson: string) => void): () => void;
  close(): void;
}

// The engine, once initialized.
export interface EngineInstance {
  // Handle one HTTP request against the whole /api/v1/* app-domain surface.
  handleHttp(req: Request): Promise<Response>;
  // Register an already-authenticated client for WS-equivalent frame exchange.
  // The embedder authenticates at its transport boundary and passes the id in.
  connect(clientId: string): EngineConnection;
  shutdown(): Promise<void>;
}

export function init(host: Host): Promise<EngineInstance> {
  const frameBus = new FrameBus();
  host.log("info", "engine", "engine init (skeleton; services land in later phases)");

  const instance: EngineInstance = {
    handleHttp(_req: Request): Promise<Response> {
      return Promise.resolve(new Response("not implemented", { status: 501 }));
    },
    connect(clientId: string): EngineConnection {
      return frameBus.registerConnection(clientId);
    },
    shutdown(): Promise<void> {
      frameBus.closeAll();
      return Promise.resolve();
    },
  };
  return Promise.resolve(instance);
}
