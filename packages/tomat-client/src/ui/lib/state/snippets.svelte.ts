/**
 * Reactive store for the user's saved snippets. Snippets are pure client-side
 * preferences (small, intrinsically per-device) and live in
 * ~/.tomat/client/settings.json under the "snippets" key.
 */

import { browser } from "$app/environment";
import { platform } from "$lib/platform";
import type { Snippet } from "$lib/shared/snippets";

const KEY = "snippets";

class SnippetsState {
  snippets = $state<Snippet[]>([]);

  async load(): Promise<void> {
    if (!browser) return;
    try {
      const settings = await platform().clientSettings.read();
      const raw = settings[KEY];
      this.snippets = Array.isArray(raw) ? (raw as Snippet[]) : [];
    } catch (e) {
      console.warn("Failed to load snippets:", e);
    }
  }

  async save(snippet: Snippet): Promise<void> {
    if (!browser) return;
    const settings = await platform().clientSettings.read();
    const current = Array.isArray(settings[KEY]) ? (settings[KEY] as Snippet[]) : [];
    const filtered = current.filter((s) => s.id !== snippet.id);
    const next = filtered.concat(snippet);
    settings[KEY] = next;
    await platform().clientSettings.write(settings);
    this.snippets = next;
  }

  async delete(id: string): Promise<void> {
    if (!browser) return;
    const settings = await platform().clientSettings.read();
    const current = Array.isArray(settings[KEY]) ? (settings[KEY] as Snippet[]) : [];
    const next = current.filter((s) => s.id !== id);
    settings[KEY] = next;
    await platform().clientSettings.write(settings);
    this.snippets = next;
  }

  findByTrigger(trigger: string): Snippet | undefined {
    const t = trigger.toLowerCase();
    return this.snippets.find((s) => s.trigger.toLowerCase() === t);
  }
}

export const snippetsState = new SnippetsState();
