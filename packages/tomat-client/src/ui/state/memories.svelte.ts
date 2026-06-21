/**
 * Reactive mirror of the active core's memory list. Memories live on the
 * core (markdown files + index rows); the client caches the metadata for the
 * Memories settings manager and the @-autocomplete. The cache reloads on
 * every WS connect, so it follows core switches and reconnects.
 */

import type { Memory, MemoryMeta } from "@tomat/shared";
import { cores } from "$lib/core";
import { getLogger } from "$lib/util/log";

const log = getLogger("memories");

/** The @-token a memory responds to: its filename stem ("meeting-notes.md"
 *  -> "@meeting-notes"). A stem with characters outside the bare-token set
 *  (a hand-placed file like "My Notes.md") uses the quoted form
 *  `@"my notes"`, which the matcher on both sides understands. The core
 *  resolves these tokens at generation time; the client only offers them in
 *  autocomplete and never expands them. */
export function memoryTrigger(meta: MemoryMeta): string {
  const stem = meta.filename.replace(/\.md$/, "").toLowerCase();
  return /^[a-z0-9_-]+$/.test(stem) ? `@${stem}` : `@"${stem}"`;
}

class MemoriesState {
  memories = $state<MemoryMeta[]>([]);

  private unsubscribeConn: (() => void) | null = null;

  /** Subscribe to the active core's connection state and (re)load the list on
   *  every connected edge. Idempotent, mirroring toolkitsState.attach(). */
  attach(): void {
    if (this.unsubscribeConn) return;
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      if (state === "connected") {
        void this.load().catch((err) => log.warn("memory load on ws connect failed:", err));
      }
    });
  }

  async load(): Promise<void> {
    this.memories = await cores().api().memories.list();
  }

  async create(title: string, content = ""): Promise<Memory> {
    const doc = await cores().api().memories.create(title, content);
    await this.load();
    return doc;
  }

  get(id: string): Promise<Memory> {
    return cores().api().memories.get(id);
  }

  async update(id: string, patch: { title?: string; content?: string }): Promise<Memory> {
    const doc = await cores().api().memories.update(id, patch);
    await this.load();
    return doc;
  }

  async delete(id: string): Promise<void> {
    await cores().api().memories.delete(id);
    this.memories = this.memories.filter((d) => d.id !== id);
  }

  async rescan(): Promise<{ added: number; removed: number; changed: number }> {
    const result = await cores().api().memories.rescan();
    await this.load();
    return result;
  }
}

export const memoriesState = new MemoriesState();
