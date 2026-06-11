# @tomat/shared

Pure TypeScript types and Zod validators consumed by both core and client: the
API contract, domain shapes, the `tools.json` schema, and the WS frame unions.
No runtime side effects; importing this package never touches the network,
filesystem, or globals. The wire-format rule: when changing the wire format,
update this package first, then adapt core and client to it.

## Layout

- `src/api/`: the HTTP route request/response types (`http.ts`), the WS frame
  discriminated unions (`ws.ts`), and the shared error codes (`errors.ts`).
- `src/domain/`: domain shapes: catalog, session, toolkit, model, prompts,
  storage, recommendations, and the settings system under `settings/`
  (engine, types, and one file per group in `groups/`).
- `src/validation/`: Zod schemas for inbound payloads, including
  `tools-json.ts` (the toolkit manifest), chat, pairing, session, and WS
  frames.
- `src/crypto/`: `pake.ts` (CPace PAKE used for pairing) and `canonical.ts`
  (canonical JSON serialization for manifest signing).
- `src/tools-json-schema.json`: the published JSON Schema for toolkit authors,
  generated from the Zod schema and served from `get.au.tomat.ing`.

## Run, build, test

No build step; both core and client import the TypeScript sources directly.
From the repo root:

- `deno task test:shared`: run this package's tests.

## Further reading

- [`src/domain/settings/README.md`](src/domain/settings/README.md): the
  settings system plus copy and terminology guidelines.
- [`../tomat-builtin-toolkit/README.md`](../tomat-builtin-toolkit/README.md):
  toolkit author docs for the `tools.json` format.
