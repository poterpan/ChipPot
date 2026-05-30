// Discord signs each interaction request with Ed25519. The signed message is
// `timestamp + rawBody`; the signature is in `X-Signature-Ed25519` (hex) and the
// timestamp in `X-Signature-Timestamp`. Verified against the app's Ed25519 public key.

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Verify a raw signature over `timestamp + body` with an Ed25519 public key (hex). */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string
): Promise<boolean> {
  let key: CryptoKey;
  let sig: Uint8Array;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    sig = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(timestamp + body);
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
  } catch {
    return false;
  }
}

/** Verify an incoming Discord interaction Request given its already-read raw body. */
export async function verifyDiscordRequest(
  publicKeyHex: string,
  req: Request,
  rawBody: string
): Promise<boolean> {
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  return verifyDiscordSignature(publicKeyHex, signature, timestamp, rawBody);
}
