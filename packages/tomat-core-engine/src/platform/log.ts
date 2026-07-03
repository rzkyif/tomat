// Host-backed logger for engine services. `getLogger(scope)` mirrors the call
// shape of core's shared/log.ts (`const log = getLogger("x"); log.info(...)`) so
// a service moved into the engine keeps its logging lines verbatim, but every
// line routes through `host().log(level, scope, message)` instead of touching
// Deno stderr / @std/log directly. The host owns formatting + secret scrubbing.

import type { LogLevel } from "../host.ts";
import { host } from "./runtime.ts";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function getLogger(scope: string): Logger {
  const at =
    (level: LogLevel) =>
    (message: string): void =>
      host().log(level, scope, message);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}
