import type { Env } from "../env";
import { nowUtcIso } from "./time";
import { ensurePeriodPayment } from "./billing";

// ── R2 key + image validation ────────────────────────────────────────────────

/** R2 object key: {workspace_id}/{period}/{user_id}/{stamp}.{ext} (spec §7.8). */
export function buildScreenshotKey(
  workspaceId: number,
  period: string,
  userId: number,
  ext: string,
  stamp: string
): string {
  return `${workspaceId}/${period}/${userId}/${stamp}.${ext}`;
}

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class InvalidImage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImage";
  }
}

export function extForContentType(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default: throw new InvalidImage(`unsupported content type: ${contentType}`);
  }
}

/** MIME + size guard (Discord path doesn't transcode; web path is client-compressed). */
export function assertImageOk(
  contentType: string,
  sizeBytes: number,
  opts?: { maxBytes?: number }
): void {
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new InvalidImage(`unsupported content type: ${contentType}`);
  }
  const max = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!(sizeBytes > 0) || sizeBytes > max) {
    throw new InvalidImage(`size out of range: ${sizeBytes}`);
  }
}

// ── R2 primitives ────────────────────────────────────────────────────────────

export type R2Body = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: R2Body,
  contentType: string
): Promise<void> {
  await bucket.put(key, body, { httpMetadata: { contentType } });
}

export function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

// ── Token-gated proof submission with R2/D1 compensation (spec §7.7) ──────────

export class TokenUnusable extends Error {
  constructor(public readonly tokenHash: string) {
    super("upload token is unusable (used, expired, revoked, or mismatched)");
    this.name = "TokenUnusable";
  }
}

export class NoEligiblePayment extends Error {
  constructor(public readonly subscriptionId: number, public readonly period: string) {
    super(`no payment eligible for proof in subscription ${subscriptionId} / ${period}`);
    this.name = "NoEligiblePayment";
  }
}

// ── Settle a user's whole period at once (multi-subscription aggregation) ─────

export interface SettleInput {
  workspaceId: number;
  userId: number;
  period: string;
  source: string; // "user_slash" (Discord) | "user_web" (web)
  declaredChannelTagId?: number | null;
  paymentNote?: string | null;
  proof?: { body: R2Body; ext: string; contentType: string } | null;
  tokenHash?: string | null; // web path only: atomically claim the one-time token
}

export interface SettleResult {
  paidCount: number;
  totalAmount: number;
  alreadyPaidCount: number;
  screenshotKey: string | null;
  paymentIds: number[];
}

/** pending/rejected payments for this user's active subs in the period (the settle targets). */
async function settleTargets(
  env: Env, workspaceId: number, userId: number, period: string
): Promise<{ id: number; amount: number }[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT p.id AS id, p.amount AS amount FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, userId)
    .all<{ id: number; amount: number }>();
  return results;
}

async function alreadyPaidCount(
  env: Env, workspaceId: number, userId: number, period: string
): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('paid','verified')
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Settle ALL of a user's active-subscription payments for a period in one operation.
 * Discord paths (button/slash) take the direct path; the web path passes `tokenHash` to
 * additionally claim the one-time token atomically (see the token branch). A single
 * screenshot (if any) is stored once and its key shared across every settled row — the
 * screenshot_key UNIQUE index was dropped in migration 0004 to allow this.
 */
export async function settleUserPeriod(env: Env, input: SettleInput): Promise<SettleResult> {
  const { workspaceId, userId, period } = input;
  const now = nowUtcIso();

  // 1. Make sure every active sub has its period payment row (idempotent).
  const subs = await env.DB
    .prepare("SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active'")
    .bind(workspaceId, userId)
    .all<{ id: number }>();
  for (const s of subs.results) await ensurePeriodPayment(env.DB, s.id, period);

  // 2. Which rows will this settle?
  const targets = await settleTargets(env, workspaceId, userId, period);
  if (targets.length === 0) {
    // Nothing to settle. The Discord path returns the already-paid count so the caller can
    // message the user. The token path is an error — but distinguish a spent/invalid token
    // (TokenUnusable) from an already-paid period (NoEligiblePayment), so reuse of a spent
    // link reports the right thing and never consumes the token.
    if (input.tokenHash) {
      const tok = await env.DB
        .prepare(
          `SELECT 1 AS ok FROM upload_tokens
           WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
        )
        .bind(input.tokenHash, userId, period, workspaceId, now)
        .first<{ ok: number }>();
      if (!tok) throw new TokenUnusable(input.tokenHash);
      throw new NoEligiblePayment(0, period);
    }
    return {
      paidCount: 0, totalAmount: 0,
      alreadyPaidCount: await alreadyPaidCount(env, workspaceId, userId, period),
      screenshotKey: null, paymentIds: [],
    };
  }

  // 3. Store the proof once (shared key) if present.
  let key: string | null = null;
  if (input.proof && env.BUCKET) {
    key = buildScreenshotKey(workspaceId, period, userId, input.proof.ext, crypto.randomUUID());
    await putObject(env.BUCKET, key, input.proof.body, input.proof.contentType);
  }

  // 4. Apply. The web (token) path is a double-gated batch; the Discord path is a single
  //    multi-row UPDATE.
  try {
    if (input.tokenHash) {
      await applyTokenSettle(env, input, key, now);
    } else {
      await applyDirectSettle(env, input, key, now);
    }
  } catch (err) {
    if (key && env.BUCKET) await deleteObject(env.BUCKET, key).catch(() => {});
    throw err;
  }

  const paidRows = await env.DB
    .prepare(
      `SELECT p.id AS id, p.amount AS amount FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND p.paid_at = ?
         AND s.user_id = ? AND s.status = 'active'`
    )
    .bind(workspaceId, period, now, userId)
    .all<{ id: number; amount: number }>();

  // TOCTOU guard: if a concurrent settle paid these rows between the settleTargets() snapshot
  // and our UPDATE, the direct path can match 0 rows after we already stored the object —
  // compensate so it isn't orphaned. (The token path throws before reaching here on 0 rows.)
  if (paidRows.results.length === 0 && key && env.BUCKET) {
    await deleteObject(env.BUCKET, key).catch(() => {});
    key = null;
  }

  return {
    paidCount: paidRows.results.length,
    totalAmount: paidRows.results.reduce((s, r) => s + r.amount, 0),
    alreadyPaidCount: await alreadyPaidCount(env, workspaceId, userId, period),
    screenshotKey: key,
    paymentIds: paidRows.results.map((r) => r.id),
  };
}

/** Discord direct path: a single multi-row UPDATE across the user's settleable rows. */
async function applyDirectSettle(
  env: Env, input: SettleInput, key: string | null, now: string
): Promise<void> {
  const { workspaceId, userId, period } = input;
  await env.DB
    .prepare(
      `UPDATE payments
         SET status = 'paid', has_proof = ?, screenshot_key = ?, declared_channel_tag_id = ?,
             payment_note = COALESCE(?, payment_note), source = ?,
             submitted_at = ?, paid_at = ?, updated_at = ?
       WHERE workspace_id = ? AND period = ? AND status IN ('pending','rejected')
         AND subscription_id IN (
           SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active')`
    )
    .bind(
      key ? 1 : 0, key, input.declaredChannelTagId ?? null,
      input.paymentNote ?? null, input.source, now, now, now,
      workspaceId, period, workspaceId, userId
    )
    .run();
}

/**
 * Web token path: a double-gated D1 batch. The payments UPDATE fires only while the token
 * is still unused; the token claim fires only once the payments carry our paid_at marker —
 * so both apply or neither, and the one-time token can't be spent twice. The cross-gate that
 * links the two statements is the unique screenshot_key when a proof is present (a per-call
 * UUID — collision-proof), falling back to paid_at = now only for the note-only case. On an
 * ambiguous batch error we read back by that same marker before deciding whether to compensate.
 */
async function applyTokenSettle(
  env: Env, input: SettleInput, key: string | null, now: string
): Promise<void> {
  const { workspaceId, userId, period } = input;
  const tokenHash = input.tokenHash!;

  // Marker that uniquely identifies rows settled by THIS call: the proof key (unique UUID)
  // when present, else paid_at = now. `(? IS NULL AND paid_at = ?)` activates the fallback
  // only when no key was provided, so a concurrent same-millisecond settle can't satisfy it.
  const markerClause = "((p.screenshot_key = ?) OR (? IS NULL AND p.paid_at = ?))";

  const landed = () =>
    env.DB
      .prepare(
        `SELECT 1 AS ok FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND ${markerClause}
           AND s.user_id = ? AND s.status = 'active' LIMIT 1`
      )
      .bind(workspaceId, period, key, key, now, userId)
      .first<{ ok: number }>()
      .catch(() => null);

  let payChanges = 0, tokChanges = 0;
  try {
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE payments
             SET status = 'paid', has_proof = ?, screenshot_key = ?, declared_channel_tag_id = ?,
                 payment_note = COALESCE(?, payment_note), source = ?,
                 submitted_at = ?, paid_at = ?, updated_at = ?
           WHERE workspace_id = ? AND period = ? AND status IN ('pending','rejected')
             AND subscription_id IN (
               SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND status = 'active')
             AND EXISTS (SELECT 1 FROM upload_tokens t
                         WHERE t.token_hash = ? AND t.user_id = ? AND t.period = ? AND t.workspace_id = ?
                           AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?)`
        )
        .bind(
          key ? 1 : 0, key, input.declaredChannelTagId ?? null,
          input.paymentNote ?? null, input.source, now, now, now,
          workspaceId, period, workspaceId, userId,
          tokenHash, userId, period, workspaceId, now
        ),
      env.DB
        .prepare(
          `UPDATE upload_tokens
             SET used_at = ?, used_by_source = ?
           WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (SELECT 1 FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
                         WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND ${markerClause}
                           AND s.user_id = ? AND s.status = 'active')`
        )
        .bind(
          now, input.source,
          tokenHash, userId, period, workspaceId, now,
          workspaceId, period, key, key, now, userId
        ),
    ]);
    payChanges = results[0]?.meta.changes ?? 0;
    tokChanges = results[1]?.meta.changes ?? 0;
  } catch (err) {
    if (await landed()) return; // committed despite the error; keep the object
    throw err;
  }

  if (payChanges >= 1 && tokChanges === 1) return; // success

  // Nothing applied — decide the precise error (caller compensates the R2 object).
  const tok = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM upload_tokens
       WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, userId, period, workspaceId, now)
    .first<{ ok: number }>();
  if (!tok) throw new TokenUnusable(tokenHash);
  throw new NoEligiblePayment(0, period);
}

