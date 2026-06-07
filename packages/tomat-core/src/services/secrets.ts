// Secrets vault for external API keys etc.
//
// File layout (under paths().root):
//   .master-key   : 32 random bytes, base64; chmod 600 on POSIX.
//                   ONLY written when the OS keychain is unavailable
//                   (helper binary missing or libsecret unavailable on
//                   headless Linux). Otherwise the key lives in the
//                   keychain and this file is absent.
//   secrets.enc   : AES-GCM ciphertext of the JSON secrets bag.
//
// The master key is sealed in the OS keychain via the `tomat-core-keychain`
// helper binary (macOS Keychain, Linux libsecret, Windows Credential
// Manager). On headless Linux without libsecret we fall back to the
// `chmod 600` file so the daemon can still run unattended.
//
// First-run order, when generating a new master key:
//   1. Try keychainSet; it succeeds on macOS/Windows + Linux with libsecret.
//   2. If that fails, write the file with chmod 600 and a loud warning.
//
// Subsequent reads:
//   1. Try keychainGet.
//   2. If that returns null AND the file exists, read the file and try to
//      migrate it into the keychain (best-effort, deletes file on success).
//   3. If neither has it, generate a new key (loops back to first-run).
//
// Wire-format of secrets.enc: a single JSON object whose keys are secret
// names (free-form strings, e.g. "openai-api-key") and values are
// strings. We re-encrypt the whole file on every write. Secrets bags
// are tiny so we don't need per-key crypto.
//
// Encryption: AES-GCM-256. Stored bytes are 12-byte nonce ‖ ciphertext.

import { channelKeychainSuffix, paths } from "../paths.ts";
import { errMessage } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { keychainGet, keychainSet } from "./keychain.ts";

const log = getLogger("secrets");

const NONCE_LEN = 12;
const KEY_LEN = 32;
// Namespaced per install channel so a dev/beta core can't read or clobber a
// stable core's master key. Stable keeps the bare "au.tomat.core" service so
// existing keychain entries keep resolving. (In dev the keychain helper
// binary is usually absent and the .master-key file fallback, already under
// the channel-isolated paths().root, is used instead.)
const KEYCHAIN_SERVICE = `au.tomat.core${channelKeychainSuffix()}`;
const KEYCHAIN_ACCOUNT = "master-key";

let cachedKey: CryptoKey | null = null;

// Test-only: drops the cached master key so the next call rebuilds it
// from disk / keychain. Use between tests that swap TOMAT_CORE_HOME.
export function __resetForTesting(): void {
  cachedKey = null;
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

async function loadOrCreateMasterKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  // 1. Try the keychain first.
  let raw: Uint8Array | null = null;
  const fromKeychain = await keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
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
      const migrated = await keychainSet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, encodeBase64(raw));
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
    const sealed = await keychainSet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, encodeBase64(raw));
    if (sealed) {
      log.info(
        `generated new master key, sealed in OS keychain ` +
          `(service=${KEYCHAIN_SERVICE} account=${KEYCHAIN_ACCOUNT})`,
      );
    } else {
      await writeMasterKeyFile(raw);
      log.warn(
        `generated new master key at ${masterKeyPath()}. OS keychain ` +
          `unavailable (no helper binary, or libsecret missing on headless ` +
          `Linux). Back up this file or all stored secrets are lost on a ` +
          `reinstall.`,
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
}

export async function deleteSecret(name: string): Promise<boolean> {
  const bag = await readEncrypted();
  if (!(name in bag)) return false;
  delete bag[name];
  await writeEncrypted(bag);
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
  const inKeychain = await keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => null);
  if (inKeychain) return;
  const onDisk = await readMasterKeyFile().catch(() => null);
  if (onDisk) return;
  log.warn(
    `secrets.enc exists but no master key was found (OS keychain empty and no ` +
      `${masterKeyPath()}). Stored secrets can't be decrypted; restore the ` +
      `master key or re-enter your secrets in Settings. In dev, preserve ` +
      `${masterKeyPath()} across rebuilds (see DEVELOPMENT.md).`,
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
