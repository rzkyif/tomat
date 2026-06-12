# Self-update

How a running core replaces its own binary and recovers when the replacement is
broken. Two halves: [`self-updater.ts`](self-updater.ts) stages and hands off an
update, [`rollback.ts`](rollback.ts) decides on boot whether to keep it.

## Update flow ([`self-updater.ts`](self-updater.ts))

1. Fetch the core manifest and verify its Ed25519 signature against the public
   key committed in `data/signing-keys.json`. The signed payload is the whole
   manifest minus the `signature` field, canonicalized, so the `workers[]` and
   `helpers[]` entries (downloaded and executed) are covered too. Downgrades are
   always refused.
2. Pick the entry for the current platform triple, download it to `staging/`,
   and verify its sha256. Worker `.ts` files and per-triple helper binaries are
   downloaded and verified into staging first, then renamed into the live
   directories only once the whole set is good, so a mid-update network failure
   never half-installs a manifest.
3. Write the rollback marker, then spawn the `tomat-core-updater` helper binary
   with the staged path, the current binary path, and the restart args (see
   [the updater README](../../../tomat-core-updater/README.md) for the
   swap/restart contract), and exit so the updater can take over. The updater
   preserves the previous binary as `<bin>.old`.

## Boot-time rollback ([`rollback.ts`](rollback.ts))

`handleUpdateMarkerOnBoot()` runs before any service boots and reads the marker
file:

- First boot after a swap (marker present, `attempts` 0, version matches the
  running binary): bump `attempts` to 1 and schedule marker deletion after 30 s
  of uptime. The delete also removes the `<bin>.old` anchor; past that point the
  update is committed.
- Marker still present on a later boot (`attempts` >= 1): the new binary crashed
  inside the commit window. Swap `<bin>.old` back over `<bin>` and exit; the OS
  supervisor re-launches the restored previous version.
- Marker version unrelated to the running binary (already rolled back, or a
  confused state): log, delete the marker, and continue.

The trust root is the same keypair that signs `binaries.json`; the release-side
signing lives in [the website README](../../../tomat-website/README.md).
