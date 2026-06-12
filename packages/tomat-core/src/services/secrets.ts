// Secrets vault for external API keys etc.
//
// File layout (under paths().root):
//   .master-key   : 32 random bytes, base64; chmod 600 on POSIX.
//                   ONLY written when the OS keychain is not used: the dev
//                   channel (always file-based), a missing helper binary,
//                   libsecret unavailable on headless Linux, or a keychain
//                   that silently drops writes. Otherwise the key lives in
//                   the keychain and this file is absent.
//   secrets.enc   : AES-GCM ciphertext of the JSON secrets bag.
//
// The master key is sealed in the OS keychain via the `tomat-core-keychain`
// helper binary (macOS Keychain, Linux libsecret, Windows Credential
// Manager). On headless Linux without libsecret we fall back to the
// `chmod 600` file so the daemon can still run unattended. The dev channel
// never uses the OS keychain for the master key: see useOsKeychain.
//
// First-run order, when generating a new master key:
//   1. Try keychainSet and verify the value reads back identically; a
//      silently-failing keychain (the write reports success but a read
//      finds nothing) counts as unavailable. See sealInKeychainVerified.
//   2. If that fails, write the file with chmod 600 and a loud warning.
//
// Subsequent reads:
//   1. Try keychainGet.
//   2. If that returns null AND the file exists, read the file and try to
//      migrate it into the keychain (verified; deletes file on success).
//   3. If neither has it, generate a new key (loops back to first-run).
//
// Wire-format of secrets.enc: a single JSON object whose keys are secret
// names (free-form strings, e.g. "openai-api-key") and values are
// strings. We re-encrypt the whole file on every write. Secrets bags
// are tiny so we don't need per-key crypto.
//
// Encryption: AES-GCM-256. Stored bytes are 12-byte nonce ‖ ciphertext.

import { channel, channelKeychainSuffix, paths } from "../paths.ts";
import { errMessage } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { keychainGet, keychainSet } from "./keychain.ts";

const log = getLogger("secrets");

const NONCE_LEN = 12;
const KEY_LEN = 32;
// Namespaced per install channel so a dev/beta core can't read or clobber a
// stable core's master key. Stable keeps the bare "au.tomat.core" service so
// existing keychain entries keep resolving. (Dev never reads or writes this
// service: see useOsKeychain.)
const KEYCHAIN_SERVICE = `au.tomat.core${channelKeychainSuffix()}`;
const KEYCHAIN_ACCOUNT = "master-key";

let cachedKey: CryptoKey | null = null;

type SecretsListener = (names: string[]) => void;
const secretsListeners = new Set<SecretsListener>();

/** Subscribe to vault content changes. Fires with the sorted secret-name list
 *  after every successful set / delete / clear (names only, never values), so
 *  the ws hub can tell clients which secrets are configured. Same pattern as
 *  subscribeCoreSettings: sync registration, fire-and-forget listeners. */
export function subscribeSecretsChanged(fn: SecretsListener): () => void {
  secretsListeners.add(fn);
  return () => secretsListeners.delete(fn);
}

function notifySecretsChanged(names: string[]): void {
  for (const fn of secretsListeners) {
    try {
      fn(names);
    } catch (err) {
      log.warn(`secrets listener failed: ${errMessage(err)}`);
    }
  }
}

// Test-only: drops the cached master key so the next call rebuilds it
// from disk / keychain, and detaches every change listener. Use between
// tests that swap TOMAT_CORE_HOME.
export function __resetForTesting(): void {
  cachedKey = null;
  secretsListeners.clear();
}

function masterKeyPath(): string {
  return paths().root + "/.master-key";
}

async function readMasterKeyFile(): Promise<Uint8Array | null> {
  try {
    const text = (await Deno.readTextFile(masterKeyPath())).trim();
    const bytes = decodeBase64(text);
    if (bytes.length !== KEY_LEN) {
      throw new AppError(
        "internal_error",
        `.master-key has ${bytes.length} bytes; expected ${KEY_LEN}`,
      );
    }
    return bytes;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (err instanceof AppError) throw err;
    throw new AppError("internal_error", `failed to read .master-key: ${errMessage(err)}`);
  }
}

async function writeMasterKeyFile(raw: Uint8Array): Promise<void> {
  // Set the mode at creation so the key is never briefly world-readable: the
  // old write-then-chmod left a 0644 TOCTOU window. The follow-up chmod also
  // tightens a file left at 0644 by an older build. mode/chmod are Unix-only.
  await Deno.writeTextFile(masterKeyPath(), encodeBase64(raw), { mode: 0o600 });
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(masterKeyPath(), 0o600);
    } catch {
      /* best-effort */
    }
  }
}

/** Whether this channel trusts the OS keychain for the master key. The dev
 *  channel does not: its helper is an unsigned, rebuilt-at-will binary, and
 *  macOS ties keychain entries to the binary's code signature, so a key
 *  sealed today silently reads back empty after the next rebuild. Dev keeps
 *  the chmod-600 file under the channel-isolated root instead, mirroring the
 *  client's dev file-backed token store. */
function useOsKeychain(): boolean {
  return channel() !== "dev";
}

/** Seal the master key in the OS keychain and verify it reads back
 *  identically. An unsigned or oddly-entitled binary can get a successful
 *  write that never lands (macOS reports OK but stores nothing readable);
 *  trusting it would strand the key in a write-only keychain and lose the
 *  vault on the next boot. Any mismatch counts as "keychain unavailable" so
 *  callers keep the file-based fallback. */
async function sealInKeychainVerified(encoded: string): Promise<boolean> {
  if (!(await keychainSet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, encoded))) return false;
  const readBack = await keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (readBack === encoded) return true;
  log.warn(
    `OS keychain accepted the master key but read-back ` +
      `${readBack === null ? "found no entry" : "returned a different value"}; ` +
      `treating the keychain as unavailable and using the .master-key file`,
  );
  return false;
}

async function loadOrCreateMasterKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  // 1. Try the keychain first.
  let raw: Uint8Array | null = null;
  const fromKeychain = useOsKeychain()
    ? await keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    : null;
  if (fromKeychain) {
    const bytes = decodeBase64(fromKeychain);
    if (bytes.length === KEY_LEN) {
      raw = bytes;
    } else {
      log.warn(
        `keychain entry has ${bytes.length} bytes; expected ${KEY_LEN}. ` +
          `Ignoring and falling back to file/regenerate.`,
      );
    }
  }

  // 2. Fall back to the file. If found, try to migrate it into the keychain
  //    so future reads don't need the file at all.
  if (!raw) {
    const fromFile = await readMasterKeyFile();
    if (fromFile) {
      raw = fromFile;
      const migrated = useOsKeychain() ? await sealInKeychainVerified(encodeBase64(raw)) : false;
      if (migrated) {
        try {
          await Deno.remove(masterKeyPath());
          log.info(`migrated master key from .master-key file → OS keychain`);
        } catch {
          /* fine, file is still authoritative until next boot */
        }
      }
    }
  }

  // 3. Neither: generate a fresh key. Prefer keychain; fall back to file.
  if (!raw) {
    raw = crypto.getRandomValues(new Uint8Array(KEY_LEN));
    const sealed = useOsKeychain() ? await sealInKeychainVerified(encodeBase64(raw)) : false;
    if (sealed) {
      log.info(
        `generated new master key, sealed in OS keychain ` +
          `(service=${KEYCHAIN_SERVICE} account=${KEYCHAIN_ACCOUNT})`,
      );
    } else if (!useOsKeychain()) {
      await writeMasterKeyFile(raw);
      log.info(`generated new master key at ${masterKeyPath()} (dev keeps it file-based)`);
    } else {
      await writeMasterKeyFile(raw);
      log.warn(
        `generated new master key at ${masterKeyPath()}. OS keychain ` +
          `unavailable (no helper binary, libsecret missing on headless ` +
          `Linux, or the keychain silently dropped the write). Back up this ` +
          `file or all stored secrets are lost on a reinstall.`,
      );
    }
  }

  cachedKey = await crypto.subtle.importKey(
    "raw",
    raw.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedKey;
}

async function readEncrypted(): Promise<Record<string, string>> {
  let blob: Uint8Array;
  try {
    blob = await Deno.readFile(paths().secretsEncFile);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw new AppError("internal_error", `failed to read secrets.enc: ${errMessage(err)}`);
  }
  if (blob.byteLength <= NONCE_LEN) return {};
  const key = await loadOrCreateMasterKey();
  // Slice the Uint8Array views into their own buffers. We can't pass
  // `blob.subarray(...)` directly because `subarray()` shares the
  // underlying ArrayBuffer with `blob`; web-crypto reads `.buffer` and
  // sees the full file, producing "Initialization vector length not
  // supported" at decrypt time. We also can't pass the Uint8Array
  // directly because lib.dom's BufferSource = ArrayBufferView<ArrayBuffer>
  // which excludes Uint8Array<ArrayBufferLike>.
  const nonce = blob.slice(0, NONCE_LEN);
  const ciphertext = blob.slice(NONCE_LEN);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
      key,
      ciphertext.buffer as ArrayBuffer,
    );
  } catch (err) {
    throw new AppError(
      "internal_error",
      `secrets.enc decryption failed (master key mismatch?): ${errMessage(err)}`,
    );
  }
  const text = new TextDecoder().decode(plaintext);
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch {
    throw new AppError("internal_error", `secrets.enc decrypted but contained invalid JSON`);
  }
}

async function writeEncrypted(bag: Record<string, string>): Promise<void> {
  const key = await loadOrCreateMasterKey();
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(bag));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
      key,
      plaintext.buffer as ArrayBuffer,
    ),
  );
  const out = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.byteLength);

  const tmp = paths().secretsEncFile + ".tmp";
  // mode at creation closes the world-readable window before the chmod (the
  // encrypted bag still leaks nothing without the master key, but the tmp file
  // is a pointless exposure otherwise). The chmod stays as a fallback.
  await Deno.writeFile(tmp, out, { mode: 0o600 });
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(tmp, 0o600);
    } catch {
      /* best-effort */
    }
  }
  await Deno.rename(tmp, paths().secretsEncFile);
}

export async function getSecret(name: string): Promise<string | undefined> {
  const bag = await readEncrypted();
  return bag[name];
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new AppError("validation_error", "secret name must be a non-empty string");
  }
  if (typeof value !== "string") {
    throw new AppError("validation_error", "secret value must be a string");
  }
  const bag = await readEncrypted();
  bag[name] = value;
  await writeEncrypted(bag);
  notifySecretsChanged(Object.keys(bag).sort());
}

export async function deleteSecret(name: string): Promise<boolean> {
  const bag = await readEncrypted();
  if (!(name in bag)) return false;
  delete bag[name];
  await writeEncrypted(bag);
  notifySecretsChanged(Object.keys(bag).sort());
  return true;
}

export async function listSecretNames(): Promise<string[]> {
  const bag = await readEncrypted();
  return Object.keys(bag).sort();
}

/** Remove the entire encrypted vault (every stored secret). Used by the Storage
 *  view's "clear settings" factory reset. The master key in the OS keychain is
 *  harmless without ciphertext, so we just delete the file (and any stale tmp).
 *  NotFound-tolerant. */
export async function clearAllSecrets(): Promise<void> {
  for (const path of [paths().secretsEncFile, paths().secretsEncFile + ".tmp"]) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  cachedKey = null;
  notifySecretsChanged([]);
}

/** Boot-time integrity check (NON-mutating: never generates a key). If a sealed
 *  vault exists but no master key can be found (OS keychain empty AND no
 *  .master-key file), the stored secrets can't be decrypted - surface that at
 *  startup so the operator can restore the key instead of hitting an opaque
 *  failure mid-request. Common in dev when a rebuild drops the keychain entry /
 *  file but leaves secrets.enc behind. */
export async function warnIfVaultUnreadable(): Promise<void> {
  let blob: Uint8Array;
  try {
    blob = await Deno.readFile(paths().secretsEncFile);
  } catch {
    return; // no vault
  }
  if (blob.byteLength <= NONCE_LEN) return; // empty vault, nothing sealed
  // Mirror loadOrCreateMasterKey: dev only ever reads the file, so a key
  // that happens to sit in the OS keychain doesn't make the vault readable.
  const inKeychain = useOsKeychain()
    ? await keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => null)
    : null;
  if (inKeychain) return;
  const onDisk = await readMasterKeyFile().catch(() => null);
  if (onDisk) return;
  log.warn(
    `secrets.enc exists but no master key was found (OS keychain empty and no ` +
      `${masterKeyPath()}). Stored secrets can't be decrypted; restore the ` +
      `master key or re-enter your secrets in Settings. In dev, preserve ` +
      `${masterKeyPath()} across rebuilds (see packages/tomat-core/README.md).`,
  );
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
