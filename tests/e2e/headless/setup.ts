// Global test setup: a belt-and-braces afterAll that stops any core left
// running (e.g. if a spec threw before its own dispose), so a leaked core
// subprocess can't hang the runner or destabilise the next file's module load.
import { afterAll } from "vitest";
import { commands } from "vitest/browser";

afterAll(async () => {
  await commands.stopAllCores();
});
