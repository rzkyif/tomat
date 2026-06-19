import type { CollectionEntry } from "astro:content";

export type ManualEntry = CollectionEntry<"manual">;

// Section display order. A section not listed here sorts to the end (by name),
// so adding a section without touching this still renders sensibly.
const SECTION_ORDER = ["Getting Started", "Features"];

export interface ManualSection {
  name: string;
  entries: ManualEntry[];
}

/** Group manual entries into ordered sections, each sorted by `order`. */
export function groupManual(entries: ManualEntry[]): ManualSection[] {
  const bySection = new Map<string, ManualEntry[]>();
  for (const e of entries) {
    const list = bySection.get(e.data.section) ?? [];
    list.push(e);
    bySection.set(e.data.section, list);
  }
  const rank = (name: string) => {
    const i = SECTION_ORDER.indexOf(name);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  return [...bySection.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, list]) => ({
      name,
      entries: list.sort((a, b) => a.data.order - b.data.order),
    }));
}

/** The first subsection (where the "User Manual" tab and bare /manual land). */
export function firstManualHref(entries: ManualEntry[]): string {
  const first = groupManual(entries)[0]?.entries[0];
  return first ? `/manual/${first.id}` : "/manual";
}
