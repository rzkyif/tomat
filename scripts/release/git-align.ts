// Git branch alignment for the two release paths.
//
// The channel branches mirror the R2 channels: `latest` tracks what the latest
// channel has published, `stable` tracks stable. The promotion chain is a clean
// fast-forward: latest <- main, stable <- latest.
//
//   - Local release (main.ts, `deno task release`): after publishing to R2 from
//     the working tree, it fast-forwards the channel branch and pushes it so the
//     remote reflects the release. This path is guarded by strict LOCAL git
//     preconditions (assertReleaseGitState): clean tree, in sync with the
//     remote, and HEAD equal to the channel's source branch.
//   - Remote release (remote.ts, `deno task remote-release`): purely remote. It
//     fast-forwards one remote branch onto another via the GitHub refs API,
//     independent of the local working tree, and lets CI build + publish.
//
// Both no-op when the target is already aligned.

import { fail, info, ok, type ReleaseChannel, step } from "./lib.ts";

// ---------------------------------------------------------------------------
// local helpers (deno task release)

async function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" })
    .output()
    .catch(() => fail(`could not run \`git\`; is it installed and on PATH?`));
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

async function revParse(ref: string): Promise<string> {
  const out = await git(["rev-parse", ref]);
  if (out.code !== 0) fail(`git rev-parse ${ref} failed: ${out.stderr}`);
  return out.stdout;
}

/** The branch a channel promotes FROM: latest <- main, stable <- latest. */
export function channelSourceRef(channel: ReleaseChannel): string {
  return channel === "latest" ? "origin/main" : "origin/latest";
}

/** Preconditions for a LOCAL `deno task release`: a clean tree, in sync with the
 *  remote, sitting exactly on the channel's source branch. Fails loudly with an
 *  actionable message otherwise. */
export async function assertReleaseGitState(channel: ReleaseChannel): Promise<void> {
  const sourceRef = channelSourceRef(channel);
  step(`Checking git state for the ${channel} release`);

  // Refresh origin/* so the comparisons below see the true remote state.
  const fetch = await git(["fetch", "origin"]);
  if (fetch.code !== 0) fail(`git fetch origin failed: ${fetch.stderr}`);

  // Clean working tree.
  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) fail(`git status failed: ${status.stderr}`);
  if (status.stdout !== "") {
    fail(`working tree is not clean; commit or stash before releasing.\n${status.stdout}`);
  }

  // In sync with the upstream (no unpushed / unpulled commits).
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) {
    fail(`the current branch has no upstream; set tracking and sync it before releasing.`);
  }
  const head = await revParse("HEAD");
  const upstreamSha = await revParse("@{u}");
  if (head !== upstreamSha) {
    fail(
      `local branch is out of sync with ${upstream.stdout}; ` +
        `push/pull so they match before releasing.`,
    );
  }

  // HEAD must equal the channel's source branch, by commit hash.
  const sourceSha = await revParse(sourceRef);
  if (head !== sourceSha) {
    fail(
      `HEAD (${head.slice(0, 12)}) does not match ${sourceRef} (${sourceSha.slice(0, 12)}). ` +
        `To release the ${channel} channel, check out the commit equal to ${sourceRef}.`,
    );
  }
  ok(`git state clean and aligned with ${sourceRef}`);
}

/** Fast-forward the local channel branch to HEAD and push it. No-op when
 *  origin/<channel> already points at HEAD. Non-force, so a diverged channel
 *  branch is refused rather than clobbered. */
export async function pushChannelBranch(channel: ReleaseChannel): Promise<void> {
  const head = await revParse("HEAD");
  const remote = await git(["rev-parse", `origin/${channel}`]);
  if (remote.code === 0 && remote.stdout === head) {
    info(`origin/${channel} already at HEAD (${head.slice(0, 12)}); nothing to push`);
    return;
  }
  step(`Fast-forwarding origin/${channel} -> ${head.slice(0, 12)}`);
  const push = await git(["push", "origin", `HEAD:refs/heads/${channel}`]);
  if (push.code !== 0) {
    fail(`git push to ${channel} failed (non-fast-forward or rejected):\n${push.stderr}`);
  }
  ok(`pushed HEAD to origin/${channel}`);
}

// ---------------------------------------------------------------------------
// remote helpers (deno task remote-release)
//
// Purely remote: these never read the local working tree, HEAD, or branch
// position. They only resolve the GitHub repo identity ({owner}/{repo}, from the
// origin remote or GITHUB_REPOSITORY) and move refs server-side.

function repoPath(): string {
  return Deno.env.get("GITHUB_REPOSITORY") ?? "{owner}/{repo}";
}

async function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" })
    .output()
    .catch(() => fail(`could not run \`gh\`; the GitHub CLI must be installed for remote-release`));
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

/** Resolve a remote branch head SHA via the refs API, or null when the branch
 *  does not exist (a 404). */
async function remoteSha(branch: string): Promise<string | null> {
  const out = await gh([
    "api",
    `repos/${repoPath()}/git/ref/heads/${branch}`,
    "--jq",
    ".object.sha",
  ]);
  if (out.code !== 0) return null;
  return out.stdout;
}

/** The remote branches a channel transfers between: latest <- main,
 *  stable <- latest. */
export function remoteTransfer(channel: ReleaseChannel): { source: string; target: string } {
  return channel === "latest"
    ? { source: "main", target: "latest" }
    : { source: "latest", target: "stable" };
}

/** Fast-forward the remote target branch onto the remote source branch,
 *  server-side. No-op when already equal. Refuses a non-fast-forward. Moving the
 *  branch is what triggers the CI release workflow. */
export async function fastForwardRemote(channel: ReleaseChannel): Promise<void> {
  const { source, target } = remoteTransfer(channel);
  step(`Remote fast-forward: ${target} <- ${source}`);

  const sourceSha = await remoteSha(source);
  if (!sourceSha) fail(`remote branch ${source} not found; cannot promote to ${target}.`);
  const targetSha = await remoteSha(target);

  if (targetSha === sourceSha) {
    ok(`remote ${target} already == ${source} (${sourceSha.slice(0, 12)}); nothing to do`);
    return;
  }

  if (targetSha) {
    // Refuse anything that isn't a clean fast-forward: source must be ahead of
    // (a descendant of) target.
    const cmp = await gh([
      "api",
      `repos/${repoPath()}/compare/${targetSha}...${sourceSha}`,
      "--jq",
      ".status",
    ]);
    if (cmp.code !== 0) fail(`could not compare ${target}...${source}: ${cmp.stderr}`);
    if (cmp.stdout !== "ahead" && cmp.stdout !== "identical") {
      fail(
        `remote ${source} is not a fast-forward of ${target} (status: ${cmp.stdout}); ` +
          `refusing to move ${target}.`,
      );
    }
    const patch = await gh([
      "api",
      "-X",
      "PATCH",
      `repos/${repoPath()}/git/refs/heads/${target}`,
      "-f",
      `sha=${sourceSha}`,
      "-F",
      "force=false",
    ]);
    if (patch.code !== 0) fail(`failed to move ${target} to ${source}: ${patch.stderr}`);
  } else {
    // Target branch does not exist yet: create it at the source commit.
    const create = await gh([
      "api",
      "-X",
      "POST",
      `repos/${repoPath()}/git/refs`,
      "-f",
      `ref=refs/heads/${target}`,
      "-f",
      `sha=${sourceSha}`,
    ]);
    if (create.code !== 0) fail(`failed to create ${target} at ${source}: ${create.stderr}`);
  }
  ok(
    `remote ${target} -> ${sourceSha.slice(0, 12)} ` +
      `(was ${targetSha ? targetSha.slice(0, 12) : "absent"})`,
  );
}
