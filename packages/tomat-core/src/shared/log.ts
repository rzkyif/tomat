// Structured logger wrapping @std/log. Writes to stderr (for the dev console
// + journal/launchd capture) and to ~/.tomat/core/logs/core.log (rotated).
//
// All modules import getLogger("scope") to get a child logger; the scope
// becomes a prefix on every line.
//
// Every formatted line runs through `scrubSecrets` so credentials cannot
// leak into core.log or the dev console even if a caller accidentally
// interpolates one (e.g. a bad-auth error that includes the supplied
// token). Scrubbing is applied at format time, after `rec.msg` is built.

import * as log from "@std/log";
import { paths } from "../paths.ts";

let initialized = false;

// Patterns ordered most-specific-first. The labeled-form patterns run before
// the bare-token patterns so we keep the label visible while masking the value.
const SCRUBBERS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/(bearer\s+)[A-Za-z0-9_\-.~+/=]{16,}/gi, "$1<REDACTED>"],
  // X-Admin-Token: <token>  /  x-admin-token=<token>
  [/(x-admin-token\s*[:=]\s*)\S+/gi, "$1<REDACTED>"],
  // ?token=<value> in URLs / WS upgrade query strings.
  [/(\btoken=)[A-Za-z0-9_\-.]+/gi, "$1<REDACTED>"],
  // Bare base64url tokens. randomToken() in auth.ts emits 32 random bytes
  // base64url-encoded → 43 chars. 40+ catches any reasonable token width
  // without over-matching short identifiers.
  [/[A-Za-z0-9_-]{40,}/g, "<REDACTED>"],
  // Bare hex strings: admin-token file is 32 hex chars, sha256 hashes are
  // 64 hex chars. Mask both.
  [/\b[a-f0-9]{32,}\b/gi, "<REDACTED>"],
];

/** Strip credential-shaped substrings from a log line before it is written
 *  to disk or stderr. Best-effort defense: a misplaced token still leaks at
 *  the call site, but at least it doesn't persist in core.log. */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const [re, repl] of SCRUBBERS) out = out.replace(re, repl);
  return out;
}

// File handler: full ISO timestamp, no color, scrubbed. The on-disk core.log is
// a machine record, so its shape never changes.
function fileFormatter(rec: log.LogRecord): string {
  const ts = new Date(rec.datetime).toISOString();
  const scope = rec.loggerName === "default" ? "" : ` [${rec.loggerName}]`;
  return scrubSecrets(`${ts} ${rec.levelName}${scope} ${rec.msg}`);
}

// SGR color per level for the console formatter: DEBUG dim, INFO green, WARN
// yellow, ERROR red. Unknown levels fall through uncolored.
const LEVEL_COLOR: Record<string, string> = {
  DEBUG: "2",
  INFO: "32",
  WARN: "33",
  ERROR: "31",
};

// Console formatter, tuned for human reading.
//  - TOMAT_LOG_NO_TIME=1 drops the timestamp (set by scripts/dev.ts, which owns
//    a single timestamp column for the multiplexed dev console). Otherwise a
//    compact HH:MM:SS.mmm wall-clock time is shown.
//  - Color is on when TOMAT_LOG_COLOR=1 (forced by dev.ts, since core's stderr
//    is piped there and not a TTY) or when stderr is a TTY and NO_COLOR is unset.
const noTime = Deno.env.get("TOMAT_LOG_NO_TIME") === "1";
const consoleColor =
  Deno.env.get("TOMAT_LOG_COLOR") === "1" ||
  (Deno.stderr.isTerminal() && !Deno.env.get("NO_COLOR"));

function paint(code: string, s: string): string {
  return consoleColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function consoleFormatter(rec: log.LogRecord): string {
  const d = new Date(rec.datetime);
  const time = noTime
    ? ""
    : `${paint(
        "2",
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
          2,
          "0",
        )}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(
          3,
          "0",
        )}`,
      )} `;
  const level = paint(LEVEL_COLOR[rec.levelName] ?? "0", rec.levelName.padEnd(5));
  const scope = rec.loggerName === "default" ? "" : `${paint("2", `[${rec.loggerName}]`)} `;
  return scrubSecrets(`${time}${level} ${scope}${rec.msg}`);
}

export async function initLogger(): Promise<void> {
  if (initialized) return;

  await Deno.mkdir(paths().logsDir, { recursive: true });

  log.setup({
    handlers: {
      // useColors:false because consoleFormatter owns all coloring (gated on TTY /
      // TOMAT_LOG_COLOR). Otherwise std wraps every line in its own level color.
      console: new log.ConsoleHandler("DEBUG", {
        formatter: consoleFormatter,
        useColors: false,
      }),
      file: new log.RotatingFileHandler("INFO", {
        filename: paths().logFile,
        maxBytes: 10 * 1024 * 1024,
        maxBackupCount: 5,
        formatter: fileFormatter,
      }),
    },
    loggers: {
      default: { level: "DEBUG", handlers: ["console", "file"] },
    },
  });

  // Set AFTER setup so a setup() failure leaves the flag false and the
  // boot-failure catch can fall back to console.error.
  initialized = true;
}

export function isLoggerReady(): boolean {
  return initialized;
}

export function getLogger(scope?: string): log.Logger {
  if (!scope) return log.getLogger();
  // @std/log registers child loggers lazily; just ask by name and configure
  // them on first use.
  return log.getLogger(scope);
}
