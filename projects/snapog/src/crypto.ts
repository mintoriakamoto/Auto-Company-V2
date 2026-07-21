// SnapOG — symmetric encryption for API keys at rest.
//
// snapog keys are documented as low-trust, rate-limited tokens (they appear in
// public og:image URLs), so we can store them encrypted at rest and re-send
// them to the owner's verified email on request. AES-256-GCM via Web Crypto,
// with the key derived from AUTH_SECRET. Pure enough to unit-test (roundtrip).

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Returns base64(iv || ciphertext). A fresh 12-byte IV per call.
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  const ctBytes = new Uint8Array(ct);
  const packed = new Uint8Array(iv.length + ctBytes.length);
  packed.set(iv, 0);
  packed.set(ctBytes, iv.length);
  return toB64(packed);
}

// Inverse of encryptSecret. Returns null on any tamper/format/wrong-key error.
export async function decryptSecret(secret: string, packedB64: string): Promise<string | null> {
  try {
    const key = await deriveKey(secret);
    const packed = fromB64(packedB64);
    if (packed.length <= 12) return null;
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}
