# tomat-builtin-toolkit

Reference tomat toolkit bundling three sample tools. Installed by default on
fresh setups; doubles as a worked example for third-party toolkit authors.

| Tool           | Function | What it does                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| `download_url` | download | Download a file from an http(s) URL into the user's Downloads folder.          |
| `open_website` | open     | Open a URL in the default browser (macOS `open`, Linux `xdg-open`, Win `cmd`). |
| `askuser_demo` | demo     | Walk through every variant of the askUser flow (text / select / multiselect).  |

## Layout

```
.
├── tools.json     # tomat manifest: names, parameters, triggers, permissions
├── package.json   # npm metadata + the single npm dep (mime-types)
├── deno.json      # nodeModulesDir + lockfile pointer for the worker spawn
├── index.ts       # entry point: re-exports the three tool functions
└── src/
    ├── download.ts
    ├── open.ts
    ├── demo.ts
    └── types.ts   # local copy of the ToolContext shape the worker injects
```

## Permissions

Each tool declares the minimum set of Deno permissions it needs in `tools.json`.
The tomat worker pool reads them on spawn and turns them into `--allow-*` flags.
Specifically:

- `download_url` needs **net** (any http(s) host), **write** to `$downloads`,
  and **env** access for `XDG_DOWNLOAD_DIR` / `HOME` / `USERPROFILE`.
- `open_website` needs **run** access for `open`, `xdg-open`, and `cmd` (one per
  host OS).
- `askuser_demo` needs nothing: it's pure conversational.

## Author guide

Use this toolkit as a template for your own. The shape every toolkit must
respect:

1. A `tools.json` at the package root, validated against the tomat `tools-v1`
   schema (`https://au.tomat.ing/schemas/tools-v1.json`).
2. A `package.json` with `"keywords": ["tools-available"]` so it shows up in the
   in-app toolkit search.
3. Named async exports matching each tool's `"function"` field in `tools.json`.
   They're called as `fn(args, ctx)`.

Publish to npm with a name starting `tomat-toolkit-` (convention, not enforced)
and the keyword `tools-available` so users can `Install` it from Settings →
Toolkits.

## Testing your toolkit

This package ships co-located tests as the worked example for testing a toolkit.
They mock the `ToolContext` directly (no real worker bridge) so they run
wherever `deno test` does:

- `src/demo.test.ts`: exercises `askUser` (questions, progress, answer shapes).
- `src/open.test.ts`: exercises URL validation; skips the actual subprocess
  spawn (which would open a real browser).

The pattern, reduced to the minimum:

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { myTool } from "./myTool.ts";
import type { ToolContext } from "./types.ts";

function mockCtx(): ToolContext & { progress: number[] } {
  const progress: number[] = [];
  return {
    progress,
    setProgress: (p) => progress.push(p),
    askUser: () => Promise.resolve([]),
    log() {},
    signal: new AbortController().signal,
    getChatContext: () => ({ userMessage: "", sessionId: null }),
  };
}

Deno.test("myTool: progress runs 0 -> 1", async () => {
  const ctx = mockCtx();
  await myTool({ input: "x" }, ctx);
  assertEquals(ctx.progress.at(-1), 1);
});
```

What to assert:

- **Progress order**: `setProgress` is called in non-decreasing order and ends
  at 1.
- **Abort honored**: when `ctx.signal.aborted` flips mid-call, the tool exits
  with a thrown error or returns early.
- **Permission boundary**: the tool only touches the resources its `tools.json`
  declares. If it tries to fetch a host that's not in `net`, the worker pool
  blocks it; your test can assert the tool propagates the rejection cleanly.

Tests are co-located as `*.test.ts` with no tier suffix; `*.tmp.test.ts` is the
gitignored scratch variant for quick experimentation.
