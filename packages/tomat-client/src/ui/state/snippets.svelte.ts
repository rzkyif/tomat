/**
 * Reactive store for the user's saved snippets. Each snippet is its own JSON
 * file under ~/.tomat/<channel>/client/snippets/ and the directory listing is
 * the registry: dropping a shared snippet file into the folder and rescanning
 * (the Snippets manager menu) or restarting makes it available. The filename
 * stem is the snippet id; the file body holds the editable fields.
 */

import { browser } from "$app/environment";
import { platform } from "$lib/platform";
import { getLogger } from "$lib/util/log";
import {
  SNIPPET_PLACEMENT_OPTIONS,
  type Snippet,
  type SnippetPlacement,
} from "$lib/snippets/snippets";

const log = getLogger("snippets");

const PLACEMENTS = new Set<string>(SNIPPET_PLACEMENT_OPTIONS.map((o) => o.value));

// Coerce a file body (possibly hand-written or shared from elsewhere) into a
// well-formed Snippet. The id always comes from the filename, never from the
// body, so a copied file can't collide with an existing snippet's identity.
function toSnippet(id: string, data: Record<string, unknown>): Snippet {
  const placement =
    typeof data.placement === "string" && PLACEMENTS.has(data.placement)
      ? (data.placement as SnippetPlacement)
      : "append-system";
  return {
    id,
    name: typeof data.name === "string" ? data.name : id,
    trigger: typeof data.trigger === "string" ? data.trigger : "",
    placement,
    text: typeof data.text === "string" ? data.text : "",
  };
}

/** Filename-stem id for a new snippet: a slug of its name, uniquified against
 *  the taken ids so the file is human-recognizable when shared. */
function deriveId(name: string, taken: Set<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "snippet";
  if (!taken.has(slug)) return slug;
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

class SnippetsState {
  snippets = $state<Snippet[]>([]);

  /** Rescan the snippets directory. The listing is the registry, so this also
   *  picks up files the user copied in by hand. Failures keep the previous
   *  in-memory list. */
  async load(): Promise<void> {
    if (!browser) return;
    try {
      const files = await platform().snippetFiles.readAll();
      this.snippets = Object.keys(files)
        .sort()
        .map((id) => toSnippet(id, files[id]));
    } catch (e) {
      log.warn("Failed to load snippets:", e);
    }
  }

  /** Create a new snippet; the id (and filename) is derived from the name. */
  async create(partial: Omit<Snippet, "id">): Promise<Snippet> {
    const id = deriveId(partial.name, new Set(this.snippets.map((s) => s.id)));
    const snippet: Snippet = { ...partial, id };
    await this.save(snippet);
    return snippet;
  }

  /** Persist a snippet to its file. The id stays the filename even when the
   *  display name changes, so the on-disk file never moves under the user. */
  async save(snippet: Snippet): Promise<void> {
    if (!browser) return;
    const { id, ...body } = snippet;
    await platform().snippetFiles.write(id, body);
    this.snippets = this.snippets
      .filter((s) => s.id !== id)
      .concat(snippet)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async delete(id: string): Promise<void> {
    if (!browser) return;
    await platform().snippetFiles.delete(id);
    this.snippets = this.snippets.filter((s) => s.id !== id);
  }

  findByTrigger(trigger: string): Snippet | undefined {
    const t = trigger.toLowerCase();
    return this.snippets.find((s) => s.trigger.toLowerCase() === t);
  }
}

export const snippetsState = new SnippetsState();
