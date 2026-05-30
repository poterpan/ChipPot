import type { Env } from "../env";

export interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
export interface AccessJwks {
  keys: AccessJwk[];
}
export interface AccessIdentity {
  email: string;
  sub?: string;
}
export interface VerifyAccessOptions {
  jwks: AccessJwks;
  aud: string;
  issuer: string;
  now?: number; // seconds epoch
  allowedEmails?: string[]; // lower-cased; if set, email must be present
}

export class AccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDenied";
  }
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

interface JwtHeader { alg: string; kid: string }
interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  email?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

/**
 * Verify a Cloudflare Access application token (RS256). Checks signature against the
 * team's JWKS, plus aud/iss/exp/nbf and an optional email allowlist. Fails closed.
 */
export async function verifyAccessJwt(
  token: string,
  opts: VerifyAccessOptions
): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessDenied("malformed token");
  const [h, p, s] = parts as [string, string, string];

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = b64urlToJson<JwtHeader>(h);
    payload = b64urlToJson<JwtPayload>(p);
  } catch {
    throw new AccessDenied("undecodable token");
  }

  if (header.alg !== "RS256") throw new AccessDenied("unexpected alg");
  const jwk = opts.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessDenied("unknown key id");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw new AccessDenied("bad signature");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // exp is mandatory: a token without a valid expiry must never be accepted.
  if (typeof payload.exp !== "number") throw new AccessDenied("missing exp");
  if (payload.exp <= now) throw new AccessDenied("expired");
  // nbf is optional per RFC 7519; only enforced when present.
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new AccessDenied("not yet valid");
  if (payload.iss !== opts.issuer) throw new AccessDenied("bad issuer");

  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.aud)) throw new AccessDenied("bad audience");

  const email = String(payload.email ?? "");
  if (opts.allowedEmails && opts.allowedEmails.length > 0) {
    if (!opts.allowedEmails.includes(email.toLowerCase())) {
      throw new AccessDenied("email not allowed");
    }
  }
  return { email, sub: payload.sub };
}

// ── JWKS fetch + cache + request-level guard ─────────────────────────────────

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour: refresh after this
const JWKS_MAX_STALE_MS = 24 * 60 * 60 * 1000; // serve stale at most this long if refresh fails
const jwksCache = new Map<string, { jwks: AccessJwks; at: number }>();

export async function getAccessJwks(teamDomain: string): Promise<AccessJwks> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.jwks;
  let res: Response;
  try {
    res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  } catch {
    res = new Response(null, { status: 599 });
  }
  if (!res.ok) {
    // Serve stale only within the max-stale window; beyond it, fail closed so retired
    // keys can't keep validating after rotation.
    if (cached && Date.now() - cached.at < JWKS_MAX_STALE_MS) return cached.jwks;
    throw new AccessDenied("could not fetch Access certs");
  }
  const jwks = (await res.json()) as AccessJwks;
  jwksCache.set(teamDomain, { jwks, at: Date.now() });
  return jwks;
}

function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Require a valid Access identity for the request, or throw AccessDenied. */
export async function requireAccess(req: Request, env: Env): Promise<AccessIdentity> {
  const token =
    req.headers.get("Cf-Access-Jwt-Assertion") ?? readCookie(req, "CF_Authorization");
  if (!token) throw new AccessDenied("missing Access token");
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AccessDenied("Access is not configured");
  }
  const jwks = await getAccessJwks(env.ACCESS_TEAM_DOMAIN);
  const allowed = (env.ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return verifyAccessJwt(token, {
    jwks,
    aud: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`,
    allowedEmails: allowed.length ? allowed : undefined,
  });
}
