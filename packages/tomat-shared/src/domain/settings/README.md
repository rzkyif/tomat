# Settings

The settings schema lives here and is the single source of truth for both the
client renderer and the core. The layout:

- [`groups/`](groups/): one module per settings group (General, Appearance,
  LLM, ...). These are the data; each file exports its group definition.
- [`engine.ts`](engine.ts): composes the groups into the one schema both sides
  read, and handles hydration, parsing, and validation.
- [`types.ts`](types.ts): the field/section/group primitives. The structural
  mechanics (field/section/group shapes, `descriptionTier`, `destination`) are
  documented on the types themselves.
- [`index.ts`](index.ts): the barrel re-exporting the schema and types.

After the architecture overview, the rest of this file is the copy guidelines:
every `name` and `description` in a group ships straight to users, so treat
them as product copy, not code comments.

## Architecture

How a setting value moves through the system, end to end.

### Destinations and routing

Every field persists to exactly one destination, resolved by
`settingKeyDestination()` in [`engine.ts`](engine.ts): a section's
`destination` override wins (hybrid groups), otherwise the group's first
listed destination. That helper is the single routing truth for the client's
save path and the core's PATCH validation alike.

- **client** keys live in `~/.tomat/<channel>/client/settings.json`.
- **core** keys live in `~/.tomat/<channel>/core/settings.json` on the paired
  core, reached via `GET`/`PATCH /api/v1/settings`.

Both stores are sparse: only non-default values are persisted, and a `null`
in a PATCH deletes the key (reverts it to the schema default). The core PATCH
is strict (`validateSettingsPatch`): unknown keys, client-destination keys,
render-only fields, secret-typed keys, and wrong-typed values are all
rejected, and GET responses are sanitized to schema core keys, so the core
store can never carry junk to clients. Core-internal state (e.g. the built-in
toolkit seed marker) lives outside the settings store entirely.

### The client store

`settingsState` (`packages/tomat-client/src/ui/lib/state/settings.svelte.ts`)
keeps three layers: schema defaults, the client sparse layer, and the core
sparse layer. The merged record (`currentSettings`) is the one reactive
surface every reader consumes. Every mutation, whatever its origin, flows
through one pipeline that updates the owning layer, mutates the merged record
per key, and notifies `onChange` listeners only for keys whose effective
value actually changed:

- **user**: an edit from the settings UI or a programmatic `updateSetting`.
  Applied optimistically, debounced, then persisted per destination (file
  write, core PATCH diff against the last core-confirmed state, dirty secrets
  to the vault). A failed destination rolls back only its own keys, firing
  the reverse transitions.
- **load**: the client file at boot, and the core baseline GET whenever a
  core is selected or a connection (re)establishes. Core edits made before
  the baseline lands are queued and PATCHed right after it, never dropped.
- **remote**: a `settings.updated` WS frame. The core broadcasts every store
  change (another client's PATCH, a preset apply, a factory reset) as a
  sparse delta plus deleted keys; the value-diff makes the echo of this
  client's own PATCH a no-op, which is also what lets listener writebacks
  converge.

Side effects (arming TTS, stopping VAD, mutual-exclusion writebacks) live in
`settings-effects.ts` as `onChange` listeners, so they react identically to a
user toggle, a pairing's baseline, and a remote change.

### Secrets

Secret-typed (password) fields never enter the layers, the file, or a PATCH.
Values go straight to the core's encrypted vault via the secrets endpoints;
the core only ever returns the configured NAMES (`GET /settings/secrets`,
mirrored in the `secretNames` field of `settings.updated`), which drive the
"saved" placeholder in password fields. Only fields the user actually edited
in the session are written, so an unrelated save can't clear a vault entry.

### Client file tenancy

The client keeps one file per concern under `~/.tomat/<channel>/client/`, one
owner per file, so no two modules ever read-modify-write the same data:

- `settings.json`: the sparse client settings (owned by `settingsState`).
- `cores.json`: the paired-cores registry + current-core pointer (owned by
  `lib/core/cores.ts`).
- `snippets/<name>.json`: one file per snippet; the directory listing is the
  registry, the filename stem is the snippet id, so sharing a snippet is
  copying its file in and rescanning from the Snippets manager menu.

## Copy guidelines

For anyone adding or editing a setting under `groups/`.

### Voice

- Write for the user, not the implementer. A description should answer "why
  would I touch this, and what does it actually change for me?" Never explain
  how the feature works inside (no `mmproj`, "embedding similarity", "warm
  workers", "OKLCH").
- Be succinct. One short sentence is the target. The label does most of the
  work; the description fills the gap only when the label cannot.
- One concept, one term. Reuse the shared vocabulary below instead of inventing
  a synonym.

### Labels (`name`)

- Short and self-explanatory. Aim for something a user understands without the
  description. Keep them brief enough not to wrap.
- Describe what the control is, not the mechanism behind it. ("Push-to-Talk
  Mode", not "Microphone Mode"; "Unload When Idle", not "Idle Unload Seconds".)
- Never duplicate the section label. If a section is "Context Template", its one
  field is "Template", not "Context Template".
- Don't rename a field `id` when you reword its label. Ids are persisted on disk
  and on the wire.

### Descriptions (`description`)

- Add one whenever it adds user-relevant value. Skip it only when the label
  already says everything (see tiers below).
- Requests, not guarantees. When a setting only asks the model to do something
  it may not always honor, say "should" or "may". ("The language the agent
  **should** reply in"; "Whether the model **should** think before answering.")
  Use definite phrasing only for things the app enforces.
- Don't assume capabilities by provider. Say "the model must support vision",
  not "a local model must" (an external one might not either).
- Show a concrete example for opaque free-text values: model names, URLs, file
  paths. ("e.g. gpt-4o-mini", "e.g. @user/repo/branch/model.gguf"). A
  `placeholder` counts.
- Name related settings by their label when you reference them ("Turns off Send
  After Dictation"), so the cross-reference is findable.

### Description tiers (`descriptionTier`)

An `ondemand` description is cheap: a small info button the user can open if
unsure, costing no vertical space until then. Default to it generously.

- **`ondemand`** (the default): write a short, useful description and let it sit
  behind the info button. This is the overwhelming majority of fields.
- **`none`**: only when a description would add nothing over the label, or for a
  render-only / hidden field with an empty description (`command_preview`,
  `vadPersistedState`). No info button.
- **`always`**: rendered inline, no toggle. Reserve for the rare field where
  editing safely _requires_ the context: template syntax, routing rules. Today
  only `prompts.contextTemplate` and `prompts.complexityDetectionPrompt`
  qualify. Prefer `ondemand` unless you can justify the permanent vertical
  cost.

### Group descriptions

- Add a group `description` when the group's purpose is not obvious from its
  name (Dual Model, Tools), or when the group is a single `object_management`
  field whose own label carries no explanation (Snippets, Cores).
- Tier them the same way. `always` only for genuinely non-obvious concepts or
  complex modules (Dual Model, Tools); `ondemand` otherwise; omit entirely for
  self-evident groups (General, Appearance). Prefer `ondemand` unless you can
  justify the permanent vertical cost.

### Section names

- Name the thing being configured; avoid generic placeholders. ("Model Server
  Configuration", not "Custom Model".)
- A single-field section often reads better merged with its siblings: the four
  helper prompts share one "Helper Prompts" section rather than four
  one-field sections that would each collide label-with-section.

### Hybrid groups (client + core)

A group whose `destination` is `["client", "core"]` stores some settings on this
device and some on the paired core. The rule (enforced by `engine.test.ts`):

- Every section must be labeled and must set its own `destination`.
- Each field then routes to its section's destination, and the section header
  shows a Client or Core badge next to the group's two header chips.
- Put a field in the section whose destination matches where it must persist,
  not where it reads best. `tts.enabled` lives in a core section because the
  synthesis engine and its download requirements live on the core, even though
  it reads like a client toggle.

Single-destination groups leave sections unlabeled-or-labeled freely and never
set a section `destination`.

### Terminology

One term per concept, everywhere in user-facing copy:

| Concept                          | Use                                                    | Not                                     |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| A model's internal reasoning     | **Thinking** ("Show Thinking", "Thinking Budget")      | "Reasoning", "thought process"          |
| Where a model runs               | **Provider**: **Local** / **External**                 | "remote", "on-device" (mixed)           |
| Max tokens considered at once    | **Context Window**                                     | "Context Window Size", "context length" |
| CPU parallelism                  | **CPU Threads**                                        | "Processor Cores"                       |
| A bundle of tools / one function | **Toolkit** / **Tool**                                 | "plugin", "tool pack"                   |
| A conversation                   | **Session**                                            | "chat", "conversation" (mixed)          |
| A chat bubble                    | **Bubble**                                             | "message box"                           |
| Voice dictation                  | **Speech-to-Text** (engine), **Voice Input** (capture) | "Speech Input"                          |
| Reusable text fragment           | **Snippet**                                            |                                         |
| Device RAM, for sizing           | **Memory**                                             | "RAM"                                   |
| The two halves                   | **Core** (service) / **Client** (app)                  |                                         |

### Before you commit

- `deno task check`, `fmt`, `lint`, `test`. Lint bans the em dash (U+2014) and a
  capital-initial "tomat" across every tracked file, including this copy.
- Re-read each new string aloud. If it explains mechanism, trim it. If the label
  already says it, drop to `none`.
