# Settings

The settings schema lives here and is the single source of truth for both the
client renderer and the core. The layout:

- [`groups/`](groups/): one module per settings group (General, Appearance, LLM,
  ...). These are the data; each file exports its group definition.
- [`engine.ts`](engine.ts): composes the groups into the one schema both sides
  read, and handles hydration, parsing, and validation.
- [`types.ts`](types.ts): the field/section/group primitives. The structural
  mechanics (field/section/group shapes, `descriptionTier`, `destination`) are
  documented on the types themselves.
- [`index.ts`](index.ts): the barrel re-exporting the schema and types.

Every `name` and `description` in a group ships straight to users, so treat them
as product copy: the rules for writing them live in the root
[`COPY.md`](../../../../../COPY.md), which governs user-facing copy across the
whole product. The rest of this file is the architecture.

## Architecture

How a setting value moves through the system, end to end.

### Destinations and routing

Every field persists to exactly one destination, resolved by
`settingKeyDestination()` in [`engine.ts`](engine.ts): a section's `destination`
override wins (hybrid groups), otherwise the group's first listed destination.
That helper is the single routing truth for the client's save path and the
core's PATCH validation alike.

- **client** keys live in `~/.tomat/<channel>/client/settings.json`.
- **core** keys live in `~/.tomat/<channel>/core/settings.json` on the paired
  core, reached via `GET`/`PATCH /api/v1/settings`.

Both stores are sparse: only non-default values are persisted, and a `null` in a
PATCH deletes the key (reverts it to the schema default). The core PATCH is
strict (`validateSettingsPatch`): unknown keys, client-destination keys,
render-only fields, secret-typed keys, and wrong-typed values are all rejected,
and GET responses are sanitized to schema core keys, so the core store can never
carry junk to clients. Core-internal state (e.g. the built-in extension seed
marker) lives outside the settings store entirely.

### The client store

`settingsState` (`packages/tomat-client/src/ui/lib/state/settings.svelte.ts`)
keeps three layers: schema defaults, the client sparse layer, and the core
sparse layer. The merged record (`currentSettings`) is the one reactive surface
every reader consumes. Every mutation, whatever its origin, flows through one
pipeline that updates the owning layer, mutates the merged record per key, and
notifies `onChange` listeners only for keys whose effective value actually
changed:

- **user**: an edit from the settings UI or a programmatic `updateSetting`.
  Applied optimistically, debounced, then persisted per destination (file write,
  core PATCH diff against the last core-confirmed state, dirty secrets to the
  vault). A failed destination rolls back only its own keys, firing the reverse
  transitions.
- **load**: the client file at boot, and the core baseline GET whenever a core
  is selected or a connection (re)establishes. Core edits made before the
  baseline lands are queued and PATCHed right after it, never dropped.
- **remote**: a `settings.updated` WS frame. The core broadcasts every store
  change (another client's PATCH, a preset apply, a factory reset) as a sparse
  delta plus deleted keys; the value-diff makes the echo of this client's own
  PATCH a no-op, which is also what lets listener writebacks converge.

Side effects (arming TTS, stopping VAD, mutual-exclusion writebacks) live in
`settings-effects.ts` as `onChange` listeners, so they react identically to a
user toggle, a pairing's baseline, and a remote change.

### Secrets

Secret-typed (password) fields never enter the layers, the file, or a PATCH.
Values go straight to the core's encrypted vault via the secrets endpoints; the
core only ever returns the configured NAMES (`GET /settings/secrets`, mirrored
in the `secretNames` field of `settings.updated`), which drive the "saved"
placeholder in password fields. Only fields the user actually edited in the
session are written, so an unrelated save can't clear a vault entry.

### Client file tenancy

The client keeps one file per concern under `~/.tomat/<channel>/client/`, one
owner per file, so no two modules ever read-modify-write the same data:

- `settings.json`: the sparse client settings (owned by `settingsState`).
- `cores.json`: the paired-cores registry + current-core pointer (owned by
  `lib/core/cores.ts`).
- `snippets/<name>.json`: one file per snippet; the directory listing is the
  registry, the filename stem is the snippet id, so sharing a snippet is copying
  its file in and rescanning from the Snippets manager menu.
