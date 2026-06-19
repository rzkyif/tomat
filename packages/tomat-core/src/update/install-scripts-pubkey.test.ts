// The install scripts (scripts/install/{core,client}.sh) ship standalone (curl
// | bash), so they embed the Ed25519 signing public key as a literal to verify
// the release manifest signature before trusting any download. This guards that
// literal against drift from the single source of truth, data/signing-keys.json:
// a key rotation that updates one but not the other would silently break every
// install (signature verification would fail) or, worse, trust a stale key.

import { assertEquals } from "@std/assert";

const signingKeys = JSON.parse(
  await Deno.readTextFile(new URL("../../data/signing-keys.json", import.meta.url)),
) as { publicKey: string };

function embeddedPubkey(script: string): string {
  const m = script.match(/TOMAT_SIGNING_PUBKEY_B64="([^"]+)"/);
  if (!m) throw new Error("no TOMAT_SIGNING_PUBKEY_B64 in script");
  return m[1];
}

for (const name of ["core.sh", "client.sh"]) {
  Deno.test(`install ${name}: embedded signing pubkey matches signing-keys.json`, async () => {
    const script = await Deno.readTextFile(
      new URL(`../../../../scripts/install/${name}`, import.meta.url),
    );
    assertEquals(embeddedPubkey(script), signingKeys.publicKey);
  });
}
