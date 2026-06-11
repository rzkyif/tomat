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

The rest of this file is the copy guidelines: every `name` and `description`
in a group ships straight to users, so treat them as product copy, not code
comments.

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
  editing safely _requires_ the context: template syntax, routing rules, a
  network-exposure safety note. Today only `prompts.contextTemplate`,
  `prompts.complexityDetectionPrompt`, and `server.bindHost` qualify. Prefer
  `ondemand` unless you can justify the permanent vertical cost.

### Group descriptions

- Add a group `description` when the group's purpose is not obvious from its
  name (Dual Model, Tool Calling), or when the group is a single
  `object_management` field whose own label carries no explanation (Snippets,
  Toolkits, Cores).
- Tier them the same way. `always` only for the genuinely non-obvious concepts
  (the four above: Snippets, Toolkits, Cores, Dual Model); `ondemand` otherwise;
  omit entirely for self-evident groups (General, Appearance).

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
