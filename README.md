<p align="center">
<img src="./static/tomat.svg" width="100"/>
</p>

<!--
  Badge maintenance: Rust/Bun versions mirror rust-toolchain.toml and
  .bun-version respectively - bump them together when upgrading.
-->
<p align="center">
  <a href="https://github.com/rzkyif/tomat/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rzkyif/tomat/ci.yml?branch=main&label=CI&logo=github"/></a>
  <a href="https://github.com/rzkyif/tomat/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/rzkyif/tomat?include_prereleases&display_name=tag&sort=semver&label=release"/></a>
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange"/>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"/></a>
  <br/>
  <a href="rust-toolchain.toml"><img alt="Rust 1.91.1" src="https://img.shields.io/badge/rust-1.91.1-B7410E?logo=rust&logoColor=white"/></a>
  <a href=".bun-version"><img alt="Bun 1.3.12" src="https://img.shields.io/badge/bun-1.3.12-000000?logo=bun&logoColor=white"/></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/tauri-2-24C8DB?logo=tauri&logoColor=white"/>
  <img alt="Svelte 5" src="https://img.shields.io/badge/svelte-5-FF3E00?logo=svelte&logoColor=white"/>
</p>

tomat is a desktop AI client that provides easy and seamless access to state-of-the-art local speech-to-text, LLM inference, text-to-speech, and modular tool execution.

It's designed to be useful out of the box for anyone - not just developers - while remaining deeply customizable for those who want more control.

<!-- TODO: Add screenshots here -->
<!-- ![Screenshot](docs/screenshot.png) -->

## Principles

### 🔋 Batteries Included

tomat ships with reasonable defaults and zero-config model presets so you can start chatting immediately after install - no manual setup, no config files to edit. It should be something you can set up for your parents, not just yourself.

### 🔒 Local First

Maximize the usefulness of edge models running entirely on your hardware. That means privacy (your data never leaves your machine), security, and low-latency responses - while still giving you the option to connect to cloud providers when you need more capable models.

### 🪟 Native Feel

tomat integrates into your desktop as seamlessly as a native OS feature. An always-on-top overlay with click-through behavior, a global hotkey, system tray icon, and multi-monitor support - designed for zero friction with whatever else you're doing.

### 🧩 Modular & Customizable

A comprehensive settings system lets you adjust everything for your particular use case. The upcoming tool system will allow adding arbitrary tools via `.ts` scripts, making tomat extensible to any workflow.

## Features

**Local AI**

- LLMs via llama.cpp and speech-to-text via whisper.cpp, running entirely on your machine
- Automatic model downloads from Hugging Face, with a confirmation prompt before anything touches disk
- Optional fallback to any OpenAI-compatible external API for more demanding tasks

**Chat**

- Streaming responses with markdown rendering
- File attachments (picker or Ctrl+V paste), vision support, and fullscreen image previews
- Attachment files stored per-session on disk and read lazily
- Multi-monitor screen capture
- Session management and history, with auto-generated session titles driven by a configurable prompt
- Optional "Show System Prompt" bubble that displays the active system prompt (including snippet overrides) at the top of the session
- Snippets: reusable text fragments triggered by `@trigger` in the input, configurable to prepend, append, replace, or inject into either the user message or the system prompt
- Dual-model routing: simple prompts stay on the default model, complex ones route to a configured external model via a tunable complexity-detection prompt

**Speech**

- Text-to-speech that streams assistant responses to a local Kokoro-82M voice model via the bun sidecar (opt-in)
- Full multilingual voice catalog (48 voices across 14 language/region combinations)
- Configurable minimum words per chunk, synthesis speed, and pitch-preserving playback speed
- Smart batching that keeps chunks close to Kokoro's optimal token count while chaining them gap-free on top of the currently-playing audio
- Per-message play / stop controls on every assistant reply; TTS auto-stops when you switch sessions, send a new message, or turn on voice input
- Markdown, code blocks, URLs, and tables are stripped before synthesis so the voice never reads punctuation aloud

**Voice Input**

- Real-time voice activity detection with audible feedback
- Three activation modes: Manual (mic button, off on hide), Sticky (mic button, persists through hides/restarts), Push to Talk (hold the global shortcut)
- LLM-powered "Autocorrect Transcription" that fixes common speech-to-text mistakes
- LLM-powered "Merge Into Existing Input" that merges new dictation into text already present in the input
- Optional "Auto Send After Transcription" to skip the review step
- Can be disabled entirely from the model preset picker

**Configuration**

- Zero-config model presets for both LLM and STT, ordered by RAM footprint
- System prompt presets (None, Tool Only, Assistant, Custom) with optional context injection: user name, agent name, language, location, date/time, operating system
- Appearance controls: light/dark/auto theme, base text size, monitor selection, window width, window alignment
- Session persistence toggle; optional "always start a new session" on launch
- Declarative settings schema with conditional fields and per-field search
- All data stored locally in `~/.tomat/`

**Usage**

- Live RAM and CPU usage for each local service
- Disk-usage browser with per-category clear actions that protect models currently in use

## Roadmap

- **Tool server** - Bun-powered tool server that executes arbitrary `.ts` scripts as tools

## Architecture

```
┌──────────────────────────────────────────────┐
│         Svelte 5 Frontend (SvelteKit)        │
│  UI, state management, audio recording, VAD  │
└──────────────────┬───────────────────────────┘
                   │ Tauri IPC
┌──────────────────▼───────────────────────────┐
│          Tauri 2 Backend (Rust)              │
│  Window management, file I/O, sidecar        │
│  lifecycle, model downloads, file conversion │
└───┬──────────────┬───────────────────┬───────┘
    │              │                   │
    ▼              ▼                   ▼
┌────────┐    ┌────────────┐    ┌──────────────┐
│ llama  │    │  whisper   │    │     bun      │
│ server │    │  server    │    │   sidecar    │
│ :7701  │    │  :7702     │    │   :7703      │
└────────┘    └────────────┘    └──────────────┘
```

The Tauri backend manages sidecar processes (spawn, health check, restart, kill) and downloads queue one at a time. Models live in `~/.tomat/models/`, chat sessions in `~/.tomat/sessions/<session_id>/` (a `messages.json` plus any attachment files saved alongside it), and settings in `~/.tomat/settings.json` - all viewable and clearable from the Usage settings view. The bun sidecar also hosts the Kokoro-82M TTS runtime when Text-to-Speech is enabled.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Bun](https://bun.sh/)
- Platform-specific dependencies for Tauri - see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Supported Platforms

| Platform | Architecture  |
| -------- | ------------- |
| macOS    | ARM64, x86_64 |
| Linux    | ARM64, x86_64 |
| Windows  | ARM64, x86_64 |

## Getting Started

```bash
# Clone the repository
git clone https://github.com/rzkyif/tomat.git
cd tomat

# Install dependencies
bun install

# Download required binaries (llama-server, whisper-server, bun runtime,
# VAD files, ONNX runtime native binding for the bun TTS sidecar, Kokoro voices)
bun run fetch

# Start the development server
bun run dev
```

> **Note:** `bun run fetch` downloads platform-specific binaries from GitHub releases for the versions pinned in [src-tauri/binaries/versions.json](src-tauri/binaries/versions.json) and verifies each archive's SHA-256 against [src-tauri/binaries/checksums.json](src-tauri/binaries/checksums.json). Mismatches abort the install. Maintainers bump versions via `bun run fetch --update`.

## Available Scripts

| Script           | Description                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| `bun run dev`    | Start the Tauri development server                                           |
| `bun run build`  | Build the production desktop app                                             |
| `bun run fetch`  | Download sidecar binaries + stage VAD, ONNX runtime, and Kokoro voice assets |
| `bun run check`  | Run linter, formatter, Svelte type checker, and `cargo check`                |
| `bun run lint`   | Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter)                   |
| `bun run format` | Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter)               |

## Project Structure

```
src/                  Svelte 5 frontend
├── routes/           SvelteKit pages
└── lib/
    ├── components/   UI components (chat, settings, input)
    ├── state/        Reactive state (Svelte 5 runes)
    ├── sidecar/      Sidecar process communication
    └── shared/       Utilities, types, settings schema
src-tauri/            Tauri 2 backend (Rust)
└── src/
    ├── commands/     Tauri commands (paths, session, snippets, settings, storage)
    ├── error.rs      Unified AppError type + From impls
    ├── sidecar.rs    Sidecar lifecycle (supervision, health, downloads)
    └── state/types   App state and serde types
src-bun/              Bun/Elysia HTTP server (sidecar)
scripts/              Build utilities (fetch-required-files)
```

## Contributing

Tomat is in a **rapid-development phase**. All implementation is done by the maintainer ([@rzkyif](https://github.com/rzkyif)) and **external pull requests are not being reviewed or accepted** right now. The best ways to help:

- 🐛 [Report a bug](https://github.com/rzkyif/tomat/issues/new?template=bug-report.yml) - filed as an Issue so it can be tracked to resolution.
- 💡 [Suggest an improvement to an existing feature](https://github.com/rzkyif/tomat/discussions/new?category=improvement-suggestions) - filed as a Discussion.
- ✨ [Request a new feature](https://github.com/rzkyif/tomat/discussions/new?category=feature-requests) - filed as a Discussion.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full policy and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## Security

Please see [SECURITY.md](SECURITY.md) for how to report vulnerabilities and what's in scope. Do not file security issues as public GitHub issues.

## AI Disclosure

Multiple AI tools were used during the development of this project to flesh out ideas, speed up implementation, identify bugs and security issues, and more.

All contributors are responsible for the quality of their submissions to this project, regardless of the tools used to create, write, or generate them.

## License

[AGPL-3.0-only](LICENSE)
