import { edenTreaty } from "@elysiajs/eden";
import type { App } from "../../../src-bun/index";

export const eden = edenTreaty<App>("http://localhost:7703");
