/**
 * The host and port the Bun sidecar listens on. Imported by both the
 * frontend (HTTP and WebSocket clients) and the Bun sidecar itself so
 * the address only needs to be set in one place. The Rust backend's
 * health check has the same URL hardcoded; it can't import TypeScript,
 * so update it there too if you change the host or port here.
 */

export const BUN_SIDECAR_HOST = "127.0.0.1";
export const BUN_SIDECAR_PORT = 7703;

export const BUN_SIDECAR_HTTP_BASE_URL = `http://${BUN_SIDECAR_HOST}:${BUN_SIDECAR_PORT}`;
export const BUN_SIDECAR_WS_BASE_URL = `ws://${BUN_SIDECAR_HOST}:${BUN_SIDECAR_PORT}`;
