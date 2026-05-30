import { describe, expect, it } from "vitest";
import { verifyAccessJwt, AccessDenied } from "../../src/middleware/access";

const ISS = "https://team.cloudflareaccess.com";
const AUD = "aud-tag";
const NOW = 1_900_000_000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function genKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  )) as CryptoKeyPair;
}
async function jwksFor(kid: string, publicKey: CryptoKey) {
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  return { keys: [{ kid, kty: jwk.kty!, n: jwk.n!, e: jwk.e!, alg: "RS256" }] };
}
async function sign(privateKey: CryptoKey, header: object, payload: object): Promise<string> {
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const HEADER = { alg: "RS256", kid: "k1", typ: "JWT" };
const goodPayload = { aud: AUD, iss: ISS, email: "Owner@x.com", exp: NOW + 60, iat: NOW - 10 };

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the email", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, HEADER, goodPayload);
    const id = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW });
    expect(id.email).toBe("Owner@x.com");
  });

  it("rejects a wrong audience", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, HEADER, { ...goodPayload, aud: "other" });
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, HEADER, { ...goodPayload, exp: NOW - 1 });
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("rejects a token with no exp claim (fail closed)", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const { exp, ...noExp } = goodPayload;
    const token = await sign(privateKey, HEADER, noExp);
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("rejects a wrong issuer", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, HEADER, { ...goodPayload, iss: "https://evil.cloudflareaccess.com" });
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("rejects a signature from a different key (same kid)", async () => {
    const a = await genKey();
    const b = await genKey();
    const jwks = await jwksFor("k1", a.publicKey); // advertise A's public key
    const token = await sign(b.privateKey, HEADER, goodPayload); // but sign with B
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("rejects an unknown key id", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, { ...HEADER, kid: "unknown" }, goodPayload);
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("enforces an email allowlist (case-insensitive)", async () => {
    const { publicKey, privateKey } = await genKey();
    const jwks = await jwksFor("k1", publicKey);
    const token = await sign(privateKey, HEADER, goodPayload);
    // allowlist contains the email lowercased -> allowed
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW, allowedEmails: ["owner@x.com"] }))
      .resolves.toMatchObject({ email: "Owner@x.com" });
    // allowlist without the email -> denied
    await expect(verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISS, now: NOW, allowedEmails: ["other@x.com"] }))
      .rejects.toBeInstanceOf(AccessDenied);
  });
});
