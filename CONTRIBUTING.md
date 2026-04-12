# Contributing

Thanks for your interest in contributing to tomat! This guide will help you get set up and familiar with the project.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Bun](https://bun.sh/)
- Platform-specific dependencies for Tauri — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/rzkyif/tomat.git
cd tomat

# Install dependencies
bun install

# Download required binaries
bun run fetch

# Start the development server
bun run dev
```

## Code Quality

Before submitting a pull request, run the full check suite:

```bash
bun run check
```

This runs:

1. **oxlint** — Linting with auto-fix
2. **oxfmt** — Code formatting
3. **svelte-check** — Svelte/TypeScript type checking

You can also run these individually:

```bash
bun run lint      # Lint only
bun run format    # Format only
```

## Project Structure

| Directory    | Language           | Purpose                                              |
| ------------ | ------------------ | ---------------------------------------------------- |
| `src/`       | Svelte, TypeScript | Frontend UI, state management, sidecar communication |
| `src-tauri/` | Rust               | Desktop backend, sidecar lifecycle, file I/O         |
| `src-bun/`   | TypeScript         | Bun/Elysia HTTP sidecar server                       |
| `scripts/`   | JavaScript         | Build utilities                                      |

## Submitting Changes

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Run `bun run check` and ensure it passes
4. Submit a pull request with a clear description of the change

## Reporting Issues

When reporting a bug, please include:

- Your operating system and architecture
- Steps to reproduce
- Expected vs. actual behavior
- Any relevant logs or error messages
