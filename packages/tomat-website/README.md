# @tomat/website

The Astro static site behind `au.tomat.ing`. Two pages:

- **Home** (`/`): a single-viewport feature **showcase** (animated, seekable
  previews of the app built from the real `@tomat/shared/ui` components) above a
  compact install section.
- **User manual** (`/manual/...`): one MDX subsection per page, with a sidebar
  outline. Pages render the real `@tomat/shared/ui` components inline as live
  demos. Each page's "Last updated" date is derived from the file's last git
  commit at build time (see `src/lib/git-date.ts`). How to write a page: the
  root [COPY.md](../../COPY.md) (its "User manual" section).

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

- `src/pages/` -- `index.astro` (home), `install.astro` (the install page), and
  `manual/[...slug].astro` (one page per manual entry).
- `src/components/showcase/` -- the showcase: `Showcase.svelte` (snap-scroll
  track + scrub bar + auto-advance) drives per-feature stages (`ChatStage`,
  `SettingsStage`) that script a GSAP timeline over the shared view components.
- `src/components/` -- `Navbar`, `ManualOutline`, `ThemeToggle`, the install
  page's `InstallDiagram` + `InstallGenerator` (`.astro` no-JS baseline +
  `.svelte` enhanced island), and the small static `demos/` reused inside manual
  pages.
- `src/content/manual/` -- the manual markdown, grouped into sections.
- `src/lib/` -- `site.ts` (nav config), `manual.ts` (section grouping),
  `showcase.ts` (the GSAP cursor / typing / scroll helpers).
- The app look comes entirely from `@tomat/shared/ui` (components + `base.css` +
  the UnoCSS preset); the site adds only layout and the showcase choreography.

## Release & deploy

The site ships on its own track, separate from the repo-wide release. From the
**repo root**:

```sh
deno task release:website   # build Astro + wrangler deploy the landing page
```

It runs `astro build` then `wrangler deploy`, gated by the same source-hash
cursor on R2 and version-bump check the umbrella `deno task release` uses, so an
unchanged site is a no-op (pass `--force` to deploy anyway, `--dry-run` to build
without deploying). The website's version lives in
`packages/tomat-website/deno.json`; for the full version-bump table and channel
details see [DEVELOPMENT.md](../../DEVELOPMENT.md#channels). `deno task release`
publishes everything **except** the landing page.

**One-time Cloudflare setup** (needs the `tomat.ing` zone on Cloudflare):

```sh
deno run -A npm:wrangler@^4 r2 bucket create tomat-releases    # release artifacts
```

wrangler authenticates with `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`)
from the repo-root `.env`, the same credentials the rest of the release uses; if
both are blank it falls back to a stored `wrangler login` OAuth session. Then in
the Cloudflare dashboard attach the custom domains: `get.au.tomat.ing` to the R2
bucket (R2 -> tomat-releases -> Settings -> Custom Domains; enables public read)
and `au.tomat.ing` to the Worker (set on first `deploy` via `wrangler.toml`).
Seed `.env` at the repo root from `.env.example` (release-only: manifest signing
plus Cloudflare/R2 credentials; the signing keypair is generated on first run).
