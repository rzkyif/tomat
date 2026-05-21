// Structured logger wrapping @std/log. Writes to stderr (for the dev console
// + journal/launchd capture) and to ~/.tomat/core/logs/core.log (rotated).
//
// All modules import getLogger("scope") to get a child logger; the scope
// becomes a prefix on every line.

import * as log from "@std/log";
import { paths } from "../paths.ts";

let initialized = false;

export async function initLogger(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await Deno.mkdir(paths().logsDir, { recursive: true });

  log.setup({
    handlers: {
      console: new log.ConsoleHandler("DEBUG", {
        formatter: (rec) => {
          const ts = new Date(rec.datetime).toISOString();
          const scope = rec.loggerName === "default"
            ? ""
            : ` [${rec.loggerName}]`;
          return `${ts} ${rec.levelName}${scope} ${rec.msg}`;
        },
      }),
      file: new log.RotatingFileHandler("INFO", {
        filename: paths().logFile,
        maxBytes: 10 * 1024 * 1024,
        maxBackupCount: 5,
        formatter: (rec) => {
          const ts = new Date(rec.datetime).toISOString();
          const scope = rec.loggerName === "default"
            ? ""
            : ` [${rec.loggerName}]`;
          return `${ts} ${rec.levelName}${scope} ${rec.msg}`;
        },
      }),
    },
    loggers: {
      default: { level: "DEBUG", handlers: ["console", "file"] },
    },
  });
}

export function getLogger(scope?: string): log.Logger {
  if (!scope) return log.getLogger();
  // @std/log registers child loggers lazily; just ask by name and configure
  // them on first use.
  return log.getLogger(scope);
}
