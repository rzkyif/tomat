// Shared SHA-256 + hex helpers. One home for the hex-encoding and SHA-256
// digest patterns that were previously copied across downloads, toolkits,
// auth, tls, and the self-updater.

/** Lowercase hex encoding of a byte array. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a string or byte buffer, hex-encoded lowercase. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  // A passed-in Uint8Array is typed over ArrayBufferLike; digest wants a view
  // backed by a plain ArrayBuffer, so assert it (TextEncoder already returns one).
  const data = typeof input === "string"
    ? new TextEncoder().encode(input)
    : (input as Uint8Array<ArrayBuffer>);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(buf));
}

// Incremental SHA-256 over chunks. SubtleCrypto.digest is one-shot, so we
// accumulate chunks and hash on finalize - fine in memory for the file /
// folder sizes core hashes (tens of MB).
export class Sha256Stream {
  private chunks: Uint8Array[] = [];
  update(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  async hexDigest(): Promise<string> {
    const total = this.chunks.reduce((a, c) => a + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return await sha256Hex(merged);
  }
}
