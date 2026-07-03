// Subprocess helpers for the install subcommands. Kept tiny and dependency-free
// (no engine host, no logger): these run before the server boots.

import { progress } from "./io.ts";

export interface RunResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing output. On a non-zero exit it prints
 *  the stderr as progress unless `ignoreError` is set (used for probes and
 *  best-effort teardown steps that are non-zero for benign reasons). */
export async function run(
  argv: string[],
  opts: { env?: Record<string, string>; ignoreError?: boolean } = {},
): Promise<RunResult> {
  const cmd = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env: opts.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  let out: Deno.CommandOutput;
  try {
    out = await cmd.output();
  } catch (err) {
    if (!opts.ignoreError) {
      progress(`failed to spawn ${argv[0]}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { code: 127, success: false, stdout: "", stderr: String(err) };
  }
  const dec = new TextDecoder();
  const res: RunResult = {
    code: out.code,
    success: out.success,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
  if (!res.success && !opts.ignoreError) {
    progress(`command failed (exit ${res.code}): ${argv.join(" ")}: ${res.stderr.trim()}`);
  }
  return res;
}

/** Run a PowerShell snippet (Windows service registration / ACLs). Returns the
 *  result; callers decide whether a non-zero exit is fatal. */
export async function runPwsh(
  script: string,
  opts: { ignoreError?: boolean } = {},
): Promise<RunResult> {
  return await run(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    opts,
  );
}

/** The current user's home directory, independent of the TOMAT_CORE_HOME test
 *  override (service files must land in the real ~/Library or ~/.config even
 *  when core state is redirected to a tempdir). */
export function realHome(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("could not determine home directory (no HOME or USERPROFILE)");
  return home;
}
