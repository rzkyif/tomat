# Manual style guide

How to write user manual pages (`src/content/manual/**/*.mdx`). Read this before
adding or editing a page. The aim is one consistent voice across the whole
manual, so a page added a year from now reads like one written today, and so any
page can be validated against a fixed standard.

The reference for voice and pacing is the Astro guide
(https://docs.astro.build/en/concepts/why-astro/): conceptual first, calm,
task-oriented, never breathless.

## Voice and tone

- **Second person, present tense.** "You type in the bar at the bottom", not
  "users can type messages".
- **Concept before mechanics.** Open by saying what a thing is and why you would
  reach for it, then how to use it. Lead with the user's goal, not the feature.
- **Plain and confident.** Short sentences. No marketing language, no
  exclamation points, no "simply", "just", or "easy". If a step is fiddly, say
  so plainly rather than papering over it.
- **Never explain internals.** A reader does not need to know about embeddings,
  workers, OKLCH, or WebSocket frames. Describe what changes for them, not how
  the code works. (Same rule the settings copy follows.)

## Page template

Every page follows the same shape:

1. **Lead paragraph.** One short paragraph: what this is and why you would use
   it. No heading above it (the page title is the `h1`).
2. **`##` sections, one topic each.** A section is two to four developed
   paragraphs (see Density), not a single line. Use `##` only; the page title is
   the only `h1` and there is rarely cause for `###`.
3. **An inline demo in the section that introduces a surface** (see below).
4. **An aside** where a caveat, prerequisite, or tip earns one (see Asides). Used
   sparingly.
5. **A closing pointer** to the natural next page or pages, plus inline
   cross-links wherever the prose first names another topic.

Target roughly 350 to 800 words of prose per page plus its demos. A page carries
one topic: if it grows past that or starts covering two, split it.

## Density

The manual reads like Astro's guide, not like a settings tooltip. The failure
mode to avoid is a wall of one-sentence sections that each state a single fact
and stop. Each paragraph should carry a small arc:

- **What it is** (the concept, in the reader's terms),
- **how it behaves** (what happens when you use it), and
- **when you would reach for it** (the judgment call, the tradeoff, the caveat).

You do not need all three in every paragraph, but a section of two to four such
paragraphs should leave the reader knowing the concept, the mechanics, and how to
decide, not just a definition.

Scale the density to where the reader is. Getting Started pages stay light and
stepwise. Core Concepts and the feature chapters run their fullest. Settings and
maintenance pages read more like reference: shorter, more enumerated.

Reach for a **comparison table** when a choice has clear axes (Local versus
External providers; the update channels). Ground every claim in what the app
actually does (the settings group copy, the domain types); never invent a number,
a benchmark, or a metric.

## The inline-demo rule (the defining convention)

Whenever the prose discusses a system that has a tomat client surface, render
that surface inline, at the point of discussion, using a demo component from
`src/components/demos/`. Do not describe a control in the abstract, and do not
use a screenshot.

The demos are the exact same `@tomat/shared/ui` components the app renders, fed
from `@tomat/shared/ui/samples`, so what the reader sees on the page is what they
will see in the app on default settings. Place the demo right after the sentence
that introduces the thing it shows:

```mdx
import SessionBarDemo from "../../../components/demos/SessionBarDemo.svelte";

A **session** is one conversation with the agent. The bar across the top shows
its title and how much of the context window you have used.

<SessionBarDemo />
```

Pull in only the demos a page uses, one import line each. If a system has a
settings group, show it with `<SettingsPanelDemo group="..." />` at the point you
mention configuring it.

**Show the whole component, not a naked part.** When the thing you are discussing
is a piece of a larger component in the app (the quick controls live inside the
composer; the Thinking trace is a bubble in the message stack), the demo renders
that whole component and marks the relevant part with `Highlight`, rather than
floating the part alone on a frame. The highlight fades out when the reader hovers
the demo, so they see both the part and where it sits. The two reworked demos
(`QuickModelBarDemo`, `ReasoningTraceDemo`) are the worked examples; follow them
if you add a demo for a sub-part. A part that is buried inside a View with no slot
to wrap (a button drawn by the View itself) stays un-highlighted: show the whole
component and point to it in prose.

## Asides

Use the `Aside` component for a short, scannable callout that would interrupt the
flow as a sentence. Import it like a demo
(`import Aside from "../../../components/Aside.astro"`). Three types, each for one
job:

- `<Aside type="tip">` a better way to do the thing the section just described.
- `<Aside type="note">` a prerequisite or a clarification the reader needs.
- `<Aside type="caution">` something that loses data, costs money, or leaves the
  device (an External provider, a paid API, an irreversible action).

Keep each to one to three sentences. Asides are seasoning: a page with one lands;
a page with five trains the reader to skip them. If a point needs a paragraph, it
belongs in the prose, not an aside.

## Cross-linking

Link a sibling page the first time the prose names its topic, inline, not only in
a closing pointer. A reader who lands mid-manual should be able to step sideways
to a concept they are missing (`[the context window](/manual/core-concepts/sessions-and-context)`)
without hunting the sidebar. Still end most pages with a one-line pointer to the
natural next page.

## Terminology

Use one term per concept. The canonical glossary lives in the settings copy
guide ([`../tomat-shared/src/domain/settings/README.md`](../tomat-shared/src/domain/settings/README.md#terminology));
the manual uses the same words: **Thinking** (not "reasoning"), **Provider** with
**Local** / **External**, **Context Window**, **CPU Threads**, **Toolkit** and
**Tool**, **Session**, **Bubble**, **Speech-to-Text** (engine) and **Voice
Input** (capture), **Snippet**, **Memory**, **Core** (the service) and **Client**
(the app).

Phrase settings the model only honors, not enforces, as requests: "the language
the agent **should** reply in", not "the language the agent replies in".

## Formatting

- **Bold** the first mention of a UI term or named control (**session**,
  **Voice Input**, **Push-to-Talk Mode**).
- Bullet lists for enumerations and short procedures.
- Code font for literal commands, file paths, and setting ids.
- `##` for sections; never `#` (that is the title).

## Hard rules (lint-enforced)

`deno task lint` scans `.mdx` and fails the build on either of these:

- **No em dashes (U+2014).** Reword with a comma, parentheses, or a colon, or
  split the sentence. Do not substitute another dash character.
- **Always lowercase tomat**, even at the start of a sentence or heading.

## Before you commit

- `deno task check` and `deno task build:website` (catches a broken demo import
  or a renamed component prop).
- `deno task lint` (the em dash and lowercase-tomat walkers, among others).
- Open the page in `deno task dev:website` and confirm each demo renders and
  matches its card on `/gallery`. Re-read the page against this guide: lead
  paragraph, short sections, a demo wherever a surface is introduced.
