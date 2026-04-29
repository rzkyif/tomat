/**
 * Reactive store for the user's saved snippets. Mirrors the on-disk
 * snippet list managed by the Rust backend, and offers a small helper
 * for finding a snippet by its trigger.
 */

import { browser } from "$app/environment";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "$lib/shared/env";
import type { Snippet } from "$lib/shared/snippets";

class SnippetsState {
  snippets = $state<Snippet[]>([]);

  async load(): Promise<void> {
    if (!browser || !isTauri()) return;
    try {
      const list = (await invoke("list_snippets")) as Snippet[];
      this.snippets = list;
    } catch (e) {
      console.warn("Failed to load snippets:", e);
    }
  }

  async save(snippet: Snippet): Promise<void> {
    if (!browser || !isTauri()) return;
    try {
      await invoke("save_snippet", { snippet });
      await this.load();
    } catch (e) {
      console.error("Failed to save snippet:", e);
      throw e;
    }
  }

  async delete(id: string): Promise<void> {
    if (!browser || !isTauri()) return;
    try {
      await invoke("delete_snippet", { id });
      await this.load();
    } catch (e) {
      console.error("Failed to delete snippet:", e);
      throw e;
    }
  }

  findByTrigger(trigger: string): Snippet | undefined {
    const t = trigger.toLowerCase();
    return this.snippets.find((s) => s.trigger.toLowerCase() === t);
  }
}

export const snippetsState = new SnippetsState();
