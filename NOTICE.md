# Notice

Tomat is licensed under [AGPL-3.0-only](LICENSE). It incorporates and/or
distributes at runtime the following third-party components. Each is licensed
separately; please consult the upstream project for its full license text.

## Downloaded at runtime (GitHub releases)

| Component                      | Upstream                                   | License |
| ------------------------------ | ------------------------------------------ | ------- |
| llama.cpp (`llama-server`)     | <https://github.com/ggml-org/llama.cpp>    | MIT     |
| whisper.cpp (`whisper-server`) | <https://github.com/ggerganov/whisper.cpp> | MIT     |
| ggml                           | <https://github.com/ggml-org/ggml>         | MIT     |
| Bun runtime                    | <https://github.com/oven-sh/bun>           | MIT     |

## Bundled via `node_modules` / static assets

| Component                                         | Upstream                                   | License           |
| ------------------------------------------------- | ------------------------------------------ | ----------------- |
| `@ricky0123/vad-web` (Silero VAD model + worklet) | <https://github.com/ricky0123/vad>         | ISC / model terms |
| `onnxruntime-web` (WASM runtime)                  | <https://github.com/microsoft/onnxruntime> | MIT               |

## Rust dependencies

See `cargo about generate` output (to be added in CI) for a machine-readable
license report of every Rust dependency.

## TypeScript dependencies

See `bun pm ls` / npm license tooling for a machine-readable license report of
every JavaScript dependency.

When distributing built artifacts, ensure the upstream license texts (MIT /
Apache-2.0 / etc.) are included alongside the binary, either in-bundle or in the
release assets.
