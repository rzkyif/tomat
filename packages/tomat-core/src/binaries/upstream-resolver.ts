// Runtime resolution of upstream sidecar binaries.
//
// On the BETA channel, binaries.json carries resolver entries (an upstream
// GitHub repo + per-triple asset-name patterns) instead of pinned URLs, so a
// beta core installs upstream releases without us having to re-publish the
// manifest. A resolver without `pinnedTag` tracks the LATEST release; with
// `pinnedTag` it resolves that exact release (deno is pinned this way on
// every channel, because the permission prompt parsing in
// toolkits/prompt-parser.ts depends on the prompt wording of the pinned
// version). The signed manifest commits to the repo + patterns; the concrete
// download is verified against GitHub's own published sha256 digest. We
// REFUSE to install an asset that lacks a sha256 digest. There'd be no
// verifiable anchor for the bytes we're about to execute.
//
// On the STABLE channel, manifest entries are pinned at release time and this
// module isn't involved.

import type { BinaryManifestEntry, Triple, UpstreamResolver } from "@tomat/shared";
import { errMessage, isResolverEntry } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

/** Concrete download target resolved from an entry for one triple. */
export interface ResolvedBinary {
  version: string;
  url: string;
  sha256: string;
  /** Download size in bytes when the source publishes it (GitHub asset size on
   *  beta resolver entries). Pinned entries leave this unset. */
  sizeBytes?: number;
}

// Short-lived per-repo cache of the latest-release lookup. A beta update check
// resolves every sidecar kind, and the UI may poll "check for updates"
// repeatedly; unauthenticated GitHub is rate-limited (~60/hr), so we dedupe
// rapid re-resolves. The signed manifest's resolver config is the trust
// anchor; this only caches the volatile version lookup, briefly.
const RELEASE_CACHE_TTL_MS = 5 * 60_000;
const releaseCache = new Map<string, { release: GitHubRelease; atMs: number }>();

/** Test hook: drop the cached releases so mocked-fetch cases stay isolated. */
export function __resetResolverCacheForTesting(): void {
  releaseCache.clear();
}

async function fetchRelease(
  repo: string,
  pinnedTag: string | undefined,
  signal?: AbortSignal,
): Promise<GitHubRelease> {
  const cacheKey = pinnedTag ? `${repo}@${pinnedTag}` : repo;
  const cached = releaseCache.get(cacheKey);
  if (cached && Date.now() - cached.atMs < RELEASE_CACHE_TTL_MS) {
    return cached.release;
  }
  const url = pinnedTag
    ? `https://api.github.com/repos/${repo}/releases/tags/${pinnedTag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "tomat-core",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    throw new AppError(
      "manifest_fetch_failed",
      `GitHub release fetch failed for ${repo}: ${errMessage(err)}`,
    );
  }
  if (!res.ok) {
    throw new AppError(
      "manifest_fetch_failed",
      `GitHub API ${res.status} ${res.statusText} for ${url}`,
    );
  }
  const release = (await res.json()) as GitHubRelease;
  releaseCache.set(cacheKey, { release, atMs: Date.now() });
  return release;
}

/** Resolve an upstream resolver to the latest binary for `triple`. Returns
 *  null when upstream doesn't publish this triple at all (e.g. whisper.cpp
 *  ships only Windows assets, so mac/linux beta has no whisper, same as stable).
 *  Throws when the expected asset or its sha256 digest is missing. */
export async function resolveUpstream(
  resolver: UpstreamResolver,
  triple: Triple,
  signal?: AbortSignal,
): Promise<ResolvedBinary | null> {
  const pattern = resolver.assets[triple];
  if (!pattern) return null;
  const release = await fetchRelease(resolver.repo, resolver.pinnedTag, signal);
  const assetName = pattern.replace(/\{tag\}/g, release.tag_name);
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new AppError(
      "manifest_fetch_failed",
      `upstream ${resolver.repo}@${release.tag_name} has no asset "${assetName}"`,
    );
  }
  if (!asset.digest || !asset.digest.startsWith("sha256:")) {
    throw new AppError(
      "checksum_mismatch",
      `upstream asset "${assetName}" has no sha256 digest; refusing to install ` +
        `an unverifiable binary on the beta channel`,
    );
  }
  return {
    version: release.tag_name,
    url: asset.browser_download_url,
    sha256: asset.digest.slice("sha256:".length),
    sizeBytes: typeof asset.size === "number" ? asset.size : undefined,
  };
}

/** Resolve a manifest entry (pinned or resolver) to a concrete download for
 *  `triple`. Pinned entries return their stored URL+hash; resolver entries hit
 *  GitHub for the latest release. Returns null when the triple isn't covered. */
export async function resolveBinaryEntry(
  entry: BinaryManifestEntry,
  triple: Triple,
  signal?: AbortSignal,
): Promise<ResolvedBinary | null> {
  if (isResolverEntry(entry)) {
    return await resolveUpstream(entry.resolver, triple, signal);
  }
  const platform = entry.platforms[triple];
  if (!platform) return null;
  return { version: entry.version, url: platform.url, sha256: platform.sha256 };
}
