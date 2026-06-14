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

## Releasing

There is one entry point. Change anything anywhere in the repo, then run from
the **repo root**:

```sh
deno task release           # publish to the latest channel
deno task release:stable    # publish to the stable channel
```

The script rounds up every release item, diffs each against what's published,
and walks a fixed lifecycle:

1. **Plan.** For each item it computes a deterministic source hash and compares
   it to the `manifests/release-state.json` cursor on R2 (the record of each
   item's `{version, sourceHash}` as of its last release). That tells it what
   changed without compiling anything.
2. **Version gate.** Every item carries a version and must have a version
   strictly greater than what's published when its content changed. If not, the
   release is **rejected** and the script tells you exactly where to bump:

   | Item    | Bump in                                                        |
   | ------- | -------------------------------------------------------------- |
   | core    | `packages/tomat-core/src/config.ts` (`CORE_VERSION`)           |
   | toolkit | `packages/tomat-builtin-toolkit/deno.json` (`version`)         |
   | client  | `packages/tomat-client/src/tauri/tauri.conf.json` (`version`)  |
   | catalog | `packages/tomat-model-catalog/deno.json` (`version`)           |
   | scripts | `scripts/install/version.json` (`version`)                     |
   | schemas | `packages/tomat-shared/src/tools-json-schema.json` (`version`) |
   | website | `packages/tomat-website/deno.json` (`version`)                 |

3. **Confirm.** It prints the plan (`core: v0.1.0 → v0.1.1`, …) and asks a
   single `y/N`.
4. **Apply.** Only on `y` does it build + sign + upload each changed item, then
   write the updated cursor. Items that didn't change are never rebuilt, so a
   re-run with no edits reports "nothing to release".

Flags: `--triples=host|all|<csv>` (which triples to build for core/client,
default host), `--yes`/`-y` (skip the prompt, for CI), `--force` (ignore the
cursor and treat everything as changed), `--dry-run` (build locally, skip every
upload and the cursor write). Cross-platform note: `core`
cross-compiles with `--triples=all`, but the Tauri `client` is host-only, so
each platform runs the release to publish its own bundle (the host entry is
merged into `client.json`, preserving the others, and a missing-platform fill
needs no version bump). The client item is skipped entirely when the Tauri
updater keys are absent from `.env`.

What each item owns: **core** compiles `tomat-core` + the four native helpers,
hashes the workers, and signs `core.json` + `binaries.json`; **toolkit** packs
the built-in toolkit into a signed `toolkit.json` + tarball; **catalog**
compiles the `@tomat/model-catalog` families into a signed `catalog.json`;
**client** builds the host Tauri bundle and merges it into `client.json`;
**scripts**/**schemas** sync `scripts/install/*` and `tools-v1.json` to R2; and
**website** runs `astro build` → `wrangler deploy`.

End state of a successful `release`:

- `https://au.tomat.ing/`: landing page
- `https://get.au.tomat.ing/install/core.sh`: install one-liner
- `https://get.au.tomat.ing/schemas/tools-v1.json`: published schema
- `https://get.au.tomat.ing/manifests/core.json`: signed self-update manifest
- `https://get.au.tomat.ing/manifests/toolkit.json`: signed built-in toolkit manifest
- `https://get.au.tomat.ing/manifests/catalog.json`: signed local-model catalog
- `https://get.au.tomat.ing/<version>/<triple>/tomat-core`: binary

## Channels

There are two published channels, `stable` and `latest`. The unlabeled tasks
target `latest`; the `:stable` variant targets stable:

```sh
deno task build                # build everything that changed (core/client/catalog/website), latest
deno task build:stable         # ... stable channel
deno task build:core           # just tomat-core-latest + the four helpers
deno task build:core:stable    # just bare tomat-core
deno task build:client         # just the tomat-latest app bundle
deno task release              # publish everything that changed, latest channel
deno task release:stable       # ... stable channel
```

`deno task build` is the build-only counterpart to `release`: it compiles each
item whose source changed (tracked by a `dist/.build-state.json` cursor, reusing
the same `sourceHash()` the release uses) and skips the rest, so a re-run with no
edits builds nothing. `deno task clean` clears the cursor (it lives under
`dist/`), forcing a full rebuild; `--force` does the same without cleaning.

`latest` publishes to `manifests/latest/...` on the CDN and, for the sidecar
binaries (llama/whisper/deno), ships a resolver in `binaries.json`: the running
core fetches the latest upstream GitHub release at install/update time (verified
against GitHub's sha256 digest), so upstream updates reach `latest` users
without a re-release. Stable stays pinned at release time.

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
