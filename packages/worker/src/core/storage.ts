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

export interface SubmitProofInput {
  tokenHash: string;
  subscriptionId: number;
  workspaceId: number;
  userId: number;
  period: string;
  body: R2Body;
  ext: string;
  contentType: string;
  source: string; // e.g. "user_web"
  stamp: string; // deterministic key component (e.g. Date.now())
  paymentNote?: string | null;
}

export interface SubmitProofResult {
  paymentId: number;
  screenshotKey: string;
}

/**
 * Store a screenshot and atomically (within D1) claim the one-time token AND mark the
 * payment paid+proof. Order (spec §7.7): build key → R2 put → guarded D1 batch → on
 * failure, delete the R2 object (compensation).
 *
 * The D1 batch is double-gated: the payment UPDATE only fires while the token is still
 * unused, and the token UPDATE only fires once the payment carries our screenshot_key —
 * so the two either both apply or neither does, and a token can never be spent twice.
 */
export async function submitProofWithToken(
  env: Env,
  input: SubmitProofInput
): Promise<SubmitProofResult> {
  const { tokenHash, subscriptionId, workspaceId, userId, period } = input;
  const now = nowUtcIso();

  // Ensure the period's payment row exists (idempotent; no-op if cron already made it).
  await ensurePeriodPayment(env.DB, subscriptionId, period);

  const key = buildScreenshotKey(workspaceId, period, userId, input.ext, input.stamp);
  await putObject(env.BUCKET, key, input.body, input.contentType);

  try {
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE payments
             SET status = 'paid', has_proof = 1, screenshot_key = ?,
                 payment_note = COALESCE(?, payment_note),
                 source = ?, submitted_at = ?, paid_at = ?, updated_at = ?
           WHERE subscription_id = ? AND period = ? AND workspace_id = ?
             AND status IN ('pending','paid','rejected')
             AND EXISTS (SELECT 1 FROM upload_tokens t
                         WHERE t.token_hash = ? AND t.user_id = ? AND t.period = ?
                           AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?)`
        )
        .bind(
          key, input.paymentNote ?? null, input.source, now, now, now,
          subscriptionId, period, workspaceId,
          tokenHash, userId, period, now
        ),
      env.DB
        .prepare(
          `UPDATE upload_tokens
             SET used_at = ?, used_by_source = ?
           WHERE token_hash = ? AND user_id = ? AND period = ?
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (SELECT 1 FROM payments
                         WHERE subscription_id = ? AND period = ? AND screenshot_key = ?)`
        )
        .bind(
          now, input.source,
          tokenHash, userId, period, now,
          subscriptionId, period, key
        ),
    ]);

    const payChanges = results[0]?.meta.changes ?? 0;
    const tokChanges = results[1]?.meta.changes ?? 0;
    const ok = payChanges === 1 && tokChanges === 1;
    if (!ok) {
      await deleteObject(env.BUCKET, key); // compensation
      await throwSubmitError(env, tokenHash, userId, period, subscriptionId, now);
    }
  } catch (err) {
    // SQL error → roll back the R2 object too, then rethrow.
    await deleteObject(env.BUCKET, key).catch(() => {});
    throw err;
  }

  const row = await env.DB
    .prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ?")
    .bind(subscriptionId, period)
    .first<{ id: number }>();
  return { paymentId: row!.id, screenshotKey: key };
}

/** Decide which precise error to raise when the guarded batch didn't apply. */
async function throwSubmitError(
  env: Env,
  tokenHash: string,
  userId: number,
  period: string,
  subscriptionId: number,
  now: string
): Promise<never> {
  const tok = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM upload_tokens
       WHERE token_hash = ? AND user_id = ? AND period = ?
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, userId, period, now)
    .first<{ ok: number }>();
  if (!tok) throw new TokenUnusable(tokenHash);
  throw new NoEligiblePayment(subscriptionId, period);
}
