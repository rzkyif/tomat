// Site-wide navigation config. The navbar tab selector lists these top-level
// pages; the feature showcase is part of the home page (its second section),
// not a page here, and the download list lives inside the user manual.

export interface NavPage {
  id: string;
  label: string;
  href: string;
}

export const PAGES: NavPage[] = [
  { id: "home", label: "Home", href: "/" },
  // The manual is many pages; the tab opens its first subsection.
  {
    id: "manual",
    label: "User Manual",
    href: "/manual/getting-started/installing",
  },
];

// Private for now; linked anyway (no star count yet).
export const GITHUB_URL = "https://github.com/rzkyif/tomat";

/** Which top-level page a given pathname belongs to, for the navbar knob. */
export function activePageId(pathname: string): string {
  if (pathname.startsWith("/manual")) return "manual";
  return "home";
}

/** The clip-path that parks a segmented-control knob over cell `index` of
 *  `count`, matching the shared Tabs component's geometry (p-1 groove pad,
 *  rounded-large knob). Used by the navbar to position the active-page knob
 *  server-side, so it is correct with no JS. */
export function knobClipPath(index: number, count: number): string {
  const pad = "0.25rem";
  const cell = `(100% - 2 * ${pad}) / ${count}`;
  return `inset(${pad} calc(${pad} + ${cell} * ${
    count - 1 - index
  }) ${pad} calc(${pad} + ${cell} * ${index}) round var(--rounded-large))`;
}
