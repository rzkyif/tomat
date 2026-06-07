# @tomat/website

Astro static site deployed to Cloudflare Workers (Static Assets). Serves
**only** the landing page at `au.tomat.ing`. Every other artifact moved to the
R2 public bucket at `get.au.tomat.ing`:

- `/install/*`: install one-liners (`core.sh`, `client.ps1`, …)
- `/schemas/*`: published JSON schemas (`tools-v1.json`)
- `/manifests/*`: signed manifests (`core.json`, `binaries.json`,
  `client.json`, `catalog.json`)
- `/<version>/<triple>/…`: compiled binaries and the host Tauri bundle

The Worker stays request-free (free-tier); R2 serves the rest as a public bucket
with its own custom domain.

## One-time setup

You'll need a Cloudflare account with the `tomat.ing` zone added and DNS
delegated to Cloudflare. Then, from this directory:

```sh
# 1. Authenticate wrangler (browser OAuth, persists in ~/.config/.wrangler/).
deno run -A npm:wrangler@^4 login

# 2. Create the R2 bucket that holds every release artifact.
deno run -A npm:wrangler@^4 r2 bucket create tomat-releases

# 3. In the Cloudflare dashboard:
#    R2 → tomat-releases → Settings → Custom Domains
#      → add `get.au.tomat.ing` (creates DNS automatically; enables public read).
#    Workers & Pages → tomat-website → Settings → Domains & Routes
#      → confirm `au.tomat.ing` is attached as a Custom Domain
#        (wrangler.toml `routes` block does this on first `deploy`).

# 4. Seed `.env` at the repo root (one directory up) by copying .env.example.
#    The release scripts auto-generate the signing keypair on first run.
```

## Release tasks

All release-related work is decomposed into focused, idempotent tasks. Each one
cheaply probes R2 (or the website's own cursor) first and exits early when
nothing has changed. `--force` skips the probe.

Run from the **repo root**:

Channelled tasks require an explicit channel (`:stable` or `:beta`); the
channel-independent ones (`scripts`/`schemas`/`website`) serve every channel.

| Task                               | What it owns                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task release:stable`         | Runs every sub-task below in sequence (use `release:beta` for the beta channel)                                                         |
| `deno task release:core:stable`    | Compiles `tomat-core`/`updater`/`keychain`/`hwinfo`, hashes workers, signs + uploads `core.json` + `binaries.json` + binaries           |
| `deno task release:toolkit:stable` | Packs the built-in toolkit, signs + uploads `toolkit.json` + the gzipped tarball (version read from its deno.json)                      |
| `deno task release:catalog:stable` | Compiles the `@tomat/model-catalog` families into one `catalog.json`, signs + uploads it (the local-model catalog the fit engine reads) |
| `deno task release:client:stable`  | Builds the host Tauri client bundle, merges the host platform entry into `client.json`, uploads bundle + manifest                       |
| `deno task release:scripts`        | Syncs `scripts/install/*` to `get.au.tomat.ing/install/*` (per-file content compare)                                                    |
| `deno task release:schemas`        | Syncs `tools-v1.json` to `get.au.tomat.ing/schemas/`                                                                                    |
| `deno task release:website`        | Source-hash probe → `astro build` → `wrangler deploy`                                                                                   |

Every release task supports `--dry-run` (probe + build locally, skip uploads)
and `--force` (skip the idempotency probe). `release:core:*` also takes
`--triples=<list>` and `--skip-build`. To cut a new built-in toolkit version,
bump `packages/tomat-builtin-toolkit/deno.json` and run
`deno task release:toolkit:stable`. To refresh the local-model catalog, edit the
per-family files under `packages/tomat-model-catalog/` (see that package's
README; `deno task catalog:build` validates locally) and run
`deno task release:catalog:stable`.

End state of a successful `release`:

- `https://au.tomat.ing/`: landing page
- `https://get.au.tomat.ing/install/core.sh`: install one-liner
- `https://get.au.tomat.ing/schemas/tools-v1.json`: published schema
- `https://get.au.tomat.ing/manifests/core.json`: signed self-update manifest
- `https://get.au.tomat.ing/manifests/toolkit.json`: signed built-in toolkit manifest
- `https://get.au.tomat.ing/manifests/catalog.json`: signed local-model catalog
- `https://get.au.tomat.ing/<version>/<triple>/tomat-core`: binary

## Local preview

```sh
deno task dev:website       # Astro dev server at http://localhost:4321
deno task build:website     # astro build → packages/tomat-website/dist/
```

For a Workers-runtime preview (closer to production, after running `build`):

```sh
cd packages/tomat-website
deno task preview           # wrangler dev
```
