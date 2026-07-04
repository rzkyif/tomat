// Unit tests for the Windows Add/Remove Programs UninstallString builder. The
// self-elevation for a service install is what lets a Settings > Apps uninstall
// remove the root-folder Scheduled Task (which needs admin); a background
// install has no task and must not prompt.

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { buildUninstallCommand, encodePwshCommand } from "./service.ts";

/** Decode a PowerShell -EncodedCommand payload (base64 of UTF-16LE) back to a
 *  string, mirroring what powershell.exe does when it runs the elevated relaunch. */
function decodePwshCommand(b64: string): string {
  const binary = atob(b64);
  let out = "";
  for (let i = 0; i < binary.length; i += 2) {
    out += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
  }
  return out;
}

Deno.test("encodePwshCommand round-trips through the -EncodedCommand decoder", () => {
  for (const s of ["", "hi", "$env:X='a'; & 'C:\\a b\\c.exe' go", "high codepoint π pi"]) {
    assertEquals(decodePwshCommand(encodePwshCommand(s)), s);
  }
  // Pin the exact wire format PowerShell -EncodedCommand expects (base64 of
  // UTF-16LE): matches [Convert]::ToBase64String([Text.Encoding]::Unicode...).
  assertEquals(encodePwshCommand("hi"), "aABpAA==");
});

const OPTS = {
  bin: "C:\\Users\\u\\.tomat\\latest\\core\\bin\\tomat-core-latest.exe",
  root: "C:\\Users\\u\\.tomat\\latest\\core",
  channelDir: "C:\\Users\\u\\.tomat\\latest",
  ch: "latest",
};

Deno.test("background install: runs the teardown directly, no elevation prompt", () => {
  const cmd = buildUninstallCommand({ asService: false, ...OPTS });
  assertStringIncludes(cmd, "-Command \"$env:TOMAT_CHANNEL='latest'");
  assertStringIncludes(cmd, "uninstall-service");
  // No self-elevation for a background install (nothing needs admin).
  assertEquals(cmd.includes("Start-Process"), false);
  assertEquals(cmd.includes("RunAs"), false);
  assertEquals(cmd.includes("-EncodedCommand"), false);
  // Empty channel dir is swept (the residue the inline ARP command used to leave).
  assertStringIncludes(cmd, "Get-ChildItem -Force -LiteralPath $cd");
});

Deno.test("service install: self-elevates and carries the teardown as -EncodedCommand", () => {
  const cmd = buildUninstallCommand({ asService: true, ...OPTS });
  assertStringIncludes(cmd, "Start-Process powershell.exe -Verb RunAs -Wait");
  assertMatch(cmd, /-EncodedCommand','[A-Za-z0-9+/=]+'/);
  // The encoded payload is the same teardown the background path runs inline.
  const b64 = cmd.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)![1];
  const inner = decodePwshCommand(b64);
  assertStringIncludes(inner, "$env:TOMAT_CHANNEL='latest'");
  assertStringIncludes(inner, "uninstall-service");
  assertStringIncludes(inner, OPTS.root);
  assertStringIncludes(inner, "Get-ChildItem -Force -LiteralPath $cd");
});

Deno.test("paths with a single quote are escaped for the single-quoted PS literal", () => {
  const cmd = buildUninstallCommand({
    asService: false,
    bin: "C:\\o'brien\\core.exe",
    root: "C:\\o'brien\\core",
    channelDir: "C:\\o'brien",
    ch: "latest",
  });
  // Single quote doubled (PowerShell's single-quote escape), never left bare.
  assertStringIncludes(cmd, "C:\\o''brien\\core.exe");
});
