# @tomat/website

Astro static site deployed to Cloudflare Workers (Static Assets). Serves:

- `/` — in-construction landing page.
- `/manifests/core.json` — signed core self-update manifest.
- `/manifests/binaries.json` — signed sidecar-binaries manifest.
- `/install/core.sh`, `/install/core.ps1` — install one-liners.
- `/schemas/tools-v1.json` — published `tools.json` JSON Schema.

Compiled binaries live on a separate hostname (**`get.au.tomat.ing`**, R2 public
bucket direct) so the Worker stays request-free and free-tier.

## One-time setup

You'll need a Cloudflare account with the `tomat.ing` zone added and DNS
delegated to Cloudflare. Then, from this directory:

```sh
# 1. Authenticate wrangler (browser OAuth, persists in ~/.config/.wrangler/).
deno run -A npm:wrangler@^4 login

# 2. Create the R2 bucket that holds compiled binaries.
deno run -A npm:wrangler@^4 r2 bucket create tomat-releases

# 3. In the Cloudflare dashboard:
#    R2 → tomat-releases → Settings → Custom Domains
#      → add `get.au.tomat.ing` (creates DNS automatically; enables public read).
#    Workers & Pages → tomat-website → Settings → Domains & Routes
#      → confirm `au.tomat.ing` is attached as a Custom Domain
#        (wrangler.toml `routes` block does this on first `deploy`).

# 4. Seed `.env` at the repo root (one directory up) — copy .env.example
#    and run the deploy once; it auto-generates the signing keypair on
#    first run.
```

## Deploy

From the **repo root**:

```sh
deno task website:deploy
```

That script:

1. Loads (and seeds) the Ed25519 keypair in `.env`.
2. Writes the public half into `packages/tomat-core/src/signing-keys.ts`.
3. `deno compile`s tomat-core + tomat-core-updater for every Deno-supported
   triple.
4. Hashes each binary and writes a signed `core.json` manifest.
5. Stages install scripts + schemas + manifests into `public/`.
6. Builds the Astro site (`astro build`).
7. Uploads binaries to R2 under `<version>/<triple>/<file>`.
8. Deploys the Worker (`wrangler deploy`).

End state: `https://au.tomat.ing/install/core.sh` and friends are live, and
`https://get.au.tomat.ing/<version>/<triple>/tomat-core` serves the matching
binary.

## Local preview

```sh
deno task website:dev       # Astro dev server at http://localhost:4321
```

For a Workers-runtime preview (closer to production, after running `build`):

```sh
cd packages/tomat-website
deno task preview           # wrangler dev
```
