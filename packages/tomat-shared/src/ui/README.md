# Shared UI (`@tomat/shared/ui`)

The presentational layer both the client and the website render, so a preview on
the site is the same component the app ships. A future Tauri-mobile build reuses
the same layer unchanged. This file is the canonical reference for how that
layer is structured; the package [README](../../README.md), the
[website AGENTS.md](../../../tomat-website/AGENTS.md), and the
[client README](../../../tomat-client/README.md) point here.

## The pattern: presentational backbone + narrow provider

A shared component is **presentational**: props in, callbacks out, snippets for
caller-injected sub-trees. The client wraps it feeding live store state; the
website (and the gallery) wrap it feeding sample state. A truly reusable
component has no expectations from its host, so every integration arrives by
prop/callback/snippet, never by reaching into client code.

The one exception is **ambient, cross-cutting state** that would otherwise
prop-drill through many unrelated layers. That goes through the `UiContext`
provider ([context.ts](context.ts)) as dependency injection, not state
management. Members today: alignment, bubble-blur, the animation-duration
resolver, the expansion registry, system-message color, and the host facts
`platform` / `density` / `pointer`. When no provider is mounted (the website
gallery, a standalone preview), `DEFAULT_UI_CONTEXT` supplies schema defaults so
the render matches a fresh app.

Every `UiContext` is built by the **`makeUiContext(sources)`** factory, never by
hand. The settings-derived members (alignment, blur, the system-message tint -
including the "transparent value means no override" rule) are computed once in
the factory, so the three call sites (the client provider in `+layout.svelte`,
`DEFAULT_UI_CONTEXT`, and the website showcase) cannot drift. A caller supplies
only `getSetting` plus the host behaviors that genuinely differ
(`animationDurationMs`, the `expansion*` registry hooks); everything else falls
back to a presentational default.

**Expansion** (collapsible bubbles) lives in the context's per-id registry as
the single source of truth. A View reads/writes it with a Svelte function
binding
(`bind:expanded={() => ui.expansionGet(id, def), (v) => ui.expansionSet(id, v)}`)
rather than a local mirror, and calls `ui.expansionInit(id, def)` once on mount
so a default-expanded bubble seeds the registry the message-stack layout reads.

Decision rule, context vs prop: use `UiContext` only if the value is ambient,
read by many Views across unrelated subtrees, and would otherwise drill through
layers that do not care about it. Everything per-instance is a prop.

## Component tiers

Every UI component is one of four tiers. The client manifest
(`packages/tomat-client/src/ui/components/.tiers.json`) records each client
component's tier; the `check-component-tiers` walker keeps it honest.

- **A0 - Shared primitive** (`components/<Name>.svelte`, no `View` suffix): a
  leaf with no domain knowledge (Button, Input, Toggle, Bubble, Modal, ...).
- **A - Shared View** (`components/<Name>View.svelte`): a composed, domain-
  _shaped_ piece of UI that never fetches or mutates. Reads ambient state only
  via `useUiContext()`. Must have a sample and a gallery card.
- **B - Thin client container** (`<Name>.svelte` wrapping one `<Name>View`):
  logic + `<NameView ... />` + injected snippets; no markup of its own.
  Canonical example: `chat/SessionBar.svelte`.
- **C - Client-owned shell** (no single matching View): orchestrates lifecycle /
  multiple stores / browser APIs, or composes several Views. Every _visible_
  leaf inside it must be a Tier A View or A0 primitive; any raw styled leaf is
  declared as `unsharedLeaves` in the manifest. Example:
  `chat/UserInput.svelte`.

## The `*View` contract

Order `$props()` as: (1) data props (plain values/objects, never a store or a
`*State` instance); (2) `on*` callbacks (optional, with a `noop`/guarded default
so a no-handler render does not crash); (3) snippet props (render a static
stand-in when absent, as `SettingsFieldView`'s `complexField` does); (4)
`$bindable()` only for parent-owned controlled inputs.

Forbidden inside any A0/A component (enforced by `check-shared-ui-purity`):
imports from `@tomat/client` / `$lib` / `$stores` / `$composables`,
`@tauri-apps/*`, `@tomat/shared/api/*`, and any lifecycle side-effect beyond
rendering. A local presentational `$effect` on local `$state` is fine.

## Samples + gallery

[`samples/`](samples/) exports named sample prop bundles for each View, typed
`satisfies Record<string, OmitSnippetProps<ComponentProps<typeof FooView>>>` so
a prop rename OR a dropped required (non-snippet) prop fails `svelte-check`.
Snippet props are excluded ([`samples/types.ts`](samples/types.ts)) because the
renderer supplies them. Domain values come from `getDefaultSettings()` /
`SETTINGS_SCHEMA`, never hardcoded, so a sample equals a fresh app. Snippet
props are supplied by the renderer (snippets cannot live in a `.ts` file). The
`SAMPLES` registry in [`samples/index.ts`](samples/index.ts) is keyed by View
name for the coverage walker.

The website **gallery** (`packages/tomat-website/src/pages/gallery.astro` +
`components/gallery/Gallery.svelte`) renders every View under each sample with
no `UiContext` provider mounted. It is the visual drift/QA surface (toggle the
navbar theme for light/dark) and the source for the manual's screenshots. The
showcase stages consume the same samples, so demo data has one home.

## Interaction feedback (hover / press)

Clickables use the `hov:` (+1 shade) and `act:` (+2 shade) UnoCSS variants from
[uno-preset.ts](uno-preset.ts) with the `transition-interactive` shortcut, plus
the shared `use:ripple` action ([actions/ripple.ts](actions/ripple.ts)) for the
press splash. Two rules keep this working on touch:

- **`hov:` only brightens on a hover-capable pointer.** The variant's real
  `:hover` rule is gated behind `@media (hover: hover)`; only `[data-hover]`
  (the website demo cursor) is unguarded. So a "dim until hover" resting tone
  (e.g. `text-default-400 hov:text-default-700`) never brightens on a touch
  device and must not be the only legible state there.
- **Rest at the brighter shade on a coarse pointer.** A primitive whose resting
  tone relies on hover to become legible reads `useUiContext().pointer` and,
  when `"coarse"`, rests at the would-be hover shade (see `IconButton` `subtle`,
  `FlushSelect`, `SidebarItem`). Press feedback then comes from the ripple, not
  a color shift. Follow this for any new dim-until-hover control.

## Enforcement

Three walkers under `scripts/lint-plugins/`, run by `deno task lint` (strict:
`STRICT = true`, so a violation fails the build):

- `check-shared-ui-purity` - no client/tauri/api imports in A0/A components.
- `check-view-coverage` - every `*View` has a sample, a gallery card, and is
  wrapped by a client component or composed by another shared View (a
  website-only View is the single-source drift AGENTS.md forbids).
- `check-component-tiers` - every client component is classified once in
  `.tiers.json`; a Tier B entry names an existing shared View.

## Layout

- `components/` - the A0 primitives and A `*View`s, in domain subfolders that
  mirror the client tree: `primitives/` (A0 leaves), `objects/`, `chat/`,
  `chat/messages/`, `chat/userinput/`, `settings/`. Import by deep file path
  (`@tomat/shared/ui/components/chat/messages/FooView.svelte`); there are no
  barrels.
- `context.ts` - the `UiContext` interface, the `makeUiContext` factory, and
  `DEFAULT_UI_CONTEXT`.
- `samples/` - sample prop bundles, the `SAMPLES` registry, and the
  `OmitSnippetProps` helper (`types.ts`).
- `color.ts` / `animations.ts` / `types.ts` - presentational helpers and tokens.
- `uno-preset.ts` - the UnoCSS preset both apps spread.
- `styles/base.css` - design tokens (color ladders, bubble visuals, fonts).
