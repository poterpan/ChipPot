import { describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "../../src/adapters/discord/verify";
import { handleInteractions } from "../../src/routes/interactions";
import type { Env } from "../../src/env";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// workers-types lacks Ed25519 overloads for generateKey/sign; cast to a minimal shape.
const subtle = crypto.subtle as unknown as {
  generateKey(a: { name: string }, e: boolean, u: string[]): Promise<CryptoKeyPair>;
  sign(a: { name: string }, k: CryptoKey, d: BufferSource): Promise<ArrayBuffer>;
  exportKey(f: "raw", k: CryptoKey): Promise<ArrayBuffer>;
};

async function genEd25519(): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}
async function pubHexOf(pair: CryptoKeyPair): Promise<string> {
  return toHex(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
}
async function signHex(pair: CryptoKeyPair, message: string): Promise<string> {
  const sig = await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

const TIMESTAMP = String(Math.floor(Date.now() / 1000)); // fresh, passes replay window
const BODY = '{"type":1}';

describe("verifyDiscordSignature", () => {
  it("accepts a correct signature over timestamp+body", async () => {
    const pair = await genEd25519();
    const sig = await signHex(pair, TIMESTAMP + BODY);
    expect(await verifyDiscordSignature(await pubHexOf(pair), sig, TIMESTAMP, BODY)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const pair = await genEd25519();
    const sig = await signHex(pair, TIMESTAMP + BODY);
    expect(await verifyDiscordSignature(await pubHexOf(pair), sig, TIMESTAMP, '{"type":2}')).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const a = await genEd25519();
    const b = await genEd25519();
    const sig = await signHex(b, TIMESTAMP + BODY);
    expect(await verifyDiscordSignature(await pubHexOf(a), sig, TIMESTAMP, BODY)).toBe(false);
  });

  it("rejects malformed hex without throwing", async () => {
    const pair = await genEd25519();
    expect(await verifyDiscordSignature(await pubHexOf(pair), "zz", TIMESTAMP, BODY)).toBe(false);
  });
});

function interactionReq(sig: string, timestamp: string, body: string): Request {
  return new Request("https://x/interactions", {
    method: "POST",
    body,
    headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": timestamp },
  });
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("handleInteractions", () => {
  it("answers PING with PONG when the signature is valid", async () => {
    const pair = await genEd25519();
    const env = { DISCORD_PUBLIC_KEY: await pubHexOf(pair) } as Env;
    const sig = await signHex(pair, TIMESTAMP + BODY);
    const res = await handleInteractions(interactionReq(sig, TIMESTAMP, BODY), env, CTX);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ type: 1 });
  });

  it("401s an invalid signature", async () => {
    const pair = await genEd25519();
    const env = { DISCORD_PUBLIC_KEY: await pubHexOf(pair) } as Env;
    const bad = await signHex(pair, "x" + BODY); // wrong message
    const res = await handleInteractions(interactionReq(bad, TIMESTAMP, BODY), env, CTX);
    expect(res.status).toBe(401);
  });

  it("503s when no public key is configured", async () => {
    const res = await handleInteractions(interactionReq("00", TIMESTAMP, BODY), {} as Env, CTX);
    expect(res.status).toBe(503);
  });

  it("401s a stale (replayed) timestamp even with a valid signature", async () => {
    const pair = await genEd25519();
    const env = { DISCORD_PUBLIC_KEY: await pubHexOf(pair) } as Env;
    const old = String(Math.floor(Date.now() / 1000) - 3600); // 1h ago
    const sig = await signHex(pair, old + BODY);
    const res = await handleInteractions(interactionReq(sig, old, BODY), env, CTX);
    expect(res.status).toBe(401);
  });
});
