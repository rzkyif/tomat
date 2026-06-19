import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The user manual: one markdown file per subsection (each becomes its own page).
// The "Last updated" date shown on each page is derived from the file's last git
// commit at build time (see src/lib/git-date.ts), not declared in frontmatter.
const manual = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/manual" }),
  schema: z.object({
    title: z.string(),
    section: z.string(),
    /** Sort order within the section. */
    order: z.number().default(0),
    /** Optional app demo embedded above the prose: "chat" | "settings" | "install". */
    demo: z.enum(["chat", "settings", "install"]).optional(),
  }),
});

export const collections = { manual };
