// Guards the deb prerm / rpm %preun body against the data-loss-on-upgrade bug:
// the teardown that runs `uninstall-service` (which wipes ~/.tomat/<channel>/core)
// must fire ONLY on a genuine removal, never on upgrade. dpkg calls prerm with
// "remove" vs "upgrade"; rpm calls %preun with 0 (final erase) vs 1 (upgrade).

import { assertEquals, assertStringIncludes } from "@std/assert";

import { linuxPreunBody } from "./core-installers.ts";

Deno.test("linuxPreunBody only tears down on removal, not upgrade", () => {
  const body = linuxPreunBody("stable", "/usr/lib/tomat-core", "tomat-core");
  // The removal-only guard: dpkg "remove" and rpm 0 both match; "upgrade"/1 fall
  // through with no branch, so the wipe never runs on a version bump.
  assertStringIncludes(body, 'case "$1" in');
  assertStringIncludes(body, "remove|0)");
  assertStringIncludes(body, "uninstall-service");
  // The wipe is inside the guard, not at the top level.
  const beforeCase = body.slice(0, body.indexOf('case "$1" in'));
  assertEquals(beforeCase.includes("uninstall-service"), false);
});
