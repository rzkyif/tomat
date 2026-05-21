# tomat-builtin-toolkit

Reference Tomat toolkit bundling three sample tools. Installed by default on
fresh setups; doubles as a worked example for third-party toolkit authors.

| Tool           | Function | What it does                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| `download_url` | download | Download a file from an http(s) URL into the user's Downloads folder.          |
| `open_website` | open     | Open a URL in the default browser (macOS `open`, Linux `xdg-open`, Win `cmd`). |
| `askuser_demo` | demo     | Walk through every variant of the askUser flow (text / select / multiselect).  |

## Layout

```
.
├── tools.json     # Tomat manifest — names, parameters, triggers, permissions
├── package.json   # npm metadata + the single npm dep (mime-types)
├── deno.json      # nodeModulesDir + lockfile pointer for the worker spawn
├── index.ts       # entry — re-exports the three tool functions
└── src/
    ├── download.ts
    ├── open.ts
    ├── demo.ts
    └── types.ts   # local copy of the ToolContext shape the worker injects
```

## Permissions

Each tool declares the minimum set of Deno permissions it needs in `tools.json`.
The Tomat worker pool reads them on spawn and turns them into `--allow-*` flags.
Specifically:

- `download_url` needs **net** (any http(s) host), **write** to `$downloads`,
  and **env** access for `XDG_DOWNLOAD_DIR` / `HOME` / `USERPROFILE`.
- `open_website` needs **run** access for `open`, `xdg-open`, and `cmd` (one per
  host OS).
- `askuser_demo` needs nothing — it's pure conversational.

## Author guide

Use this toolkit as a template for your own. The shape every toolkit must
respect:

1. A `tools.json` at the package root, validated against the Tomat `tools-v1`
   schema (`https://au.tomat.ing/schemas/tools-v1.json`).
2. A `package.json` with `"keywords": ["tools-available"]` so it shows up in the
   in-app toolkit search.
3. Named async exports matching each tool's `"function"` field in `tools.json`.
   They're called as `fn(args, ctx)`.

Publish to npm with a name starting `tomat-toolkit-` (convention, not enforced)
and the keyword `tools-available` so users can `Install` it from Settings →
Toolkits.
