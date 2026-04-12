# tomat

<p align="center">
<img src="./static/tomat.png" width="100"/>
</p>

tomat is a desktop AI assistant that runs LLMs and speech-to-text locally via [llama.cpp](https://github.com/ggml-org/llama.cpp) and [whisper.cpp](https://github.com/ggerganov/whisper.cpp), with optional support for external OpenAI-compatible APIs.

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

- **Local AI** - Run LLMs (llama.cpp) and speech-to-text (whisper.cpp) entirely on your machine, with automatic model downloads from Hugging Face
- **External Providers** - Connect to any OpenAI-compatible API as an alternative or fallback for more demanding tasks
- **Voice Input** - Real-time voice activity detection with LLM-powered transcription autocorrect, plus sticky and push-to-talk activation modes via the global shortcut, with audible feedback on each transition
- **Chat** - Streaming responses, markdown rendering, file attachments, multi-monitor screen capture, fullscreen image previews, vision support, and session management
- **Configuration** - Zero-config model presets, system-prompt presets with optional context injection (user/agent name, language, location, date/time, OS), session-management toggles, declarative settings with conditional fields, and all data stored locally in `~/.tomat/`

## Roadmap

- **Tool server** - Bun-powered tool server that executes arbitrary `.ts` scripts as tools
- **Text-to-Speech** - TTS functionality for spoken responses
- **Dual-model system** - Route small tasks to a local model while upstreaming complex questions to a cloud provider

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

The Tauri backend manages sidecar processes (spawn, health check, restart, kill). Models are stored in `~/.tomat/models/` and downloaded from Hugging Face on demand. Settings and chat sessions are persisted as JSON in `~/.tomat/`.

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

# Download required binaries (llama-server, whisper-server, bun runtime, VAD files)
bun run fetch

# Start the development server
bun run dev
```

> **Note:** `bun run fetch` downloads platform-specific binaries from GitHub releases for all supported targets. The first run may take a while depending on your network speed. Subsequent runs skip downloads if versions are already up to date.

## Available Scripts

| Script           | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `bun run dev`    | Start the Tauri development server                             |
| `bun run build`  | Build the production desktop app                               |
| `bun run fetch`  | Download required sidecar binaries and VAD runtime files       |
| `bun run check`  | Run linter, formatter, Svelte type checker, and `cargo check`  |
| `bun run lint`   | Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter)     |
| `bun run format` | Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) |

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
└── src/              Commands, sidecar management, state, types
src-bun/              Bun/Elysia HTTP server (sidecar)
scripts/              Build utilities (fetch-required-files)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## AI Disclosure

Multiple AI tools were used during the development of this project to flesh out ideas, speed up implementation, identify bugs and security issues, and more.

All contributors are responsible for the quality of their submissions to this project, regardless of the tools used to create, write, or generate them.

## License

[AGPL-3.0-only](LICENSE)
