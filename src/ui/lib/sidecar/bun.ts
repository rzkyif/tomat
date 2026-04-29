/**
 * Typed HTTP client for talking to the Bun sidecar. Pulls the route types
 * straight from the sidecar's source so request and response shapes stay
 * in sync automatically.
 */

import { edenTreaty } from "@elysiajs/eden";
import { BUN_SIDECAR_HTTP_BASE_URL } from "$lib/shared/network";
import type { App } from "../../../bun/index";

export const eden = edenTreaty<App>(BUN_SIDECAR_HTTP_BASE_URL);
