# @tomat/website

The Astro static site behind `au.tomat.ing`. Two pages:

- **Home** (`/`): a single-viewport feature **showcase** (animated, seekable
  previews of the app built from the real `@tomat/shared/ui` components) above a
  compact install section.
- **User manual** (`/manual/...`): one markdown subsection per page, with a
  sidebar outline. Each page's "Last updated" date is derived from the file's
  last git commit at build time (see `src/lib/git-date.ts`).

Release artifacts (installers, schemas, signed manifests, binaries) are **not**
served here; they live in the R2 public bucket at `get.au.tomat.ing`. The Worker
serves only the two pages above as static assets.

## Develop

```sh
deno task dev:website       # Astro dev server (http://localhost:4321)
deno task build:website     # astro build -> packages/tomat-website/dist/
```

For a Workers-runtime preview (after a full `deno task build`):

```sh
cd packages/tomat-website && deno task preview    # wrangler dev
```

## Structure

- `src/pages/` -- `index.astro` (home) and `manual/[...slug].astro` (one page per
  manual entry).
- `src/components/showcase/` -- the showcase: `Showcase.svelte` (snap-scroll
  track + scrub bar + auto-advance) drives per-feature stages (`ChatStage`,
  `SettingsStage`) that script a GSAP timeline over the shared view components.
- `src/components/` -- `Navbar`, `ManualOutline`, `InstallCard`, `ThemeToggle`,
  and the small static `demos/` reused inside manual pages.
- `src/content/manual/` -- the manual markdown, grouped into sections.
- `src/lib/` -- `site.ts` (nav config), `manual.ts` (section grouping),
  `showcase.ts` (the GSAP cursor / typing / scroll helpers).
- The app look comes entirely from `@tomat/shared/ui` (components + `base.css` +
  the UnoCSS preset); the site adds only layout and the showcase choreography.

## Release & deploy

The site is published as part of the repo-wide release. From the **repo root**:

```sh
deno task release           # publish everything changed, latest channel
deno task release:stable    # ... stable channel
```

The release rebuilds only what changed (tracked by a source-hash cursor on R2)
and gates each item behind a version bump. The website's version lives in
`packages/tomat-website/deno.json`; for the full version-bump table and channel
details see [DEVELOPMENT.md](../../DEVELOPMENT.md#channels). The website item runs
`astro build` then `wrangler deploy`.

**One-time Cloudflare setup** (needs the `tomat.ing` zone on Cloudflare):

```sh
deno run -A npm:wrangler@^4 login                              # browser OAuth
deno run -A npm:wrangler@^4 r2 bucket create tomat-releases    # release artifacts
```

Then in the Cloudflare dashboard attach the custom domains: `get.au.tomat.ing`
to the R2 bucket (R2 -> tomat-releases -> Settings -> Custom Domains; enables
public read) and `au.tomat.ing` to the Worker (set on first `deploy` via
`wrangler.toml`). Seed `.env` at the repo root from `.env.example` (release-only:
manifest signing + Cloudflare/R2 credentials; the signing keypair is generated on
first run).
