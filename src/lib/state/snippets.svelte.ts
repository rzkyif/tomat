import { browser } from "$app/environment";
import { invoke } from "@tauri-apps/api/core";
import type { Snippet } from "$lib/shared/snippets";

class SnippetsState {
  snippets = $state<Snippet[]>([]);

  async load(): Promise<void> {
    if (!browser) return;
    if (!(window as any).__TAURI_INTERNALS__) return;
    try {
      const list = (await invoke("list_snippets")) as Snippet[];
      this.snippets = list;
    } catch (e) {
      console.warn("Failed to load snippets:", e);
    }
  }

  async save(snippet: Snippet): Promise<void> {
    if (!browser || !(window as any).__TAURI_INTERNALS__) return;
    try {
      await invoke("save_snippet", { snippet });
      await this.load();
    } catch (e) {
      console.error("Failed to save snippet:", e);
      throw e;
    }
  }

  async delete(id: string): Promise<void> {
    if (!browser || !(window as any).__TAURI_INTERNALS__) return;
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
