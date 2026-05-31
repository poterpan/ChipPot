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
 * Safety properties:
 *  - The object key carries server-generated randomness, so two uploads never collide
 *    and a compensating delete can only ever remove this call's own object.
 *  - The D1 batch is double-gated: the payment UPDATE only fires while the token is
 *    still unused (and matches workspace + this subscription), and the token UPDATE only
 *    fires once the payment carries our unique screenshot_key — so both apply or neither.
 *  - Only `pending`/`rejected` payments accept a proof (spec state graph; no paid->paid).
 *  - On an ambiguous batch rejection we read back by the unique key before deleting, so a
 *    committed-but-lost-ACK never leaves D1 pointing at a deleted object.
 */
export async function submitProofWithToken(
  env: Env,
  input: SubmitProofInput
): Promise<SubmitProofResult> {
  const { tokenHash, subscriptionId, workspaceId, userId, period } = input;
  const now = nowUtcIso();

  // Ensure the period's payment row exists (idempotent; no-op if cron already made it).
  await ensurePeriodPayment(env.DB, subscriptionId, period);

  const key = buildScreenshotKey(workspaceId, period, userId, input.ext, crypto.randomUUID());
  await putObject(env.BUCKET, key, input.body, input.contentType);

  let committed = false;
  try {
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE payments
             SET status = 'paid', has_proof = 1, screenshot_key = ?,
                 payment_note = COALESCE(?, payment_note),
                 source = ?, submitted_at = ?, paid_at = ?, updated_at = ?
           WHERE subscription_id = ? AND period = ? AND workspace_id = ?
             AND status IN ('pending','rejected')
             AND EXISTS (SELECT 1 FROM upload_tokens t
                         WHERE t.token_hash = ? AND t.user_id = ? AND t.period = ?
                           AND t.workspace_id = ?
                           AND (t.subscription_id IS NULL OR t.subscription_id = ?)
                           AND t.used_at IS NULL AND t.revoked_at IS NULL
                           AND t.expires_at > ?)`
        )
        .bind(
          key, input.paymentNote ?? null, input.source, now, now, now,
          subscriptionId, period, workspaceId,
          tokenHash, userId, period, workspaceId, subscriptionId, now
        ),
      env.DB
        .prepare(
          `UPDATE upload_tokens
             SET used_at = ?, used_by_source = ?
           WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
             AND (subscription_id IS NULL OR subscription_id = ?)
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (SELECT 1 FROM payments
                         WHERE subscription_id = ? AND period = ? AND workspace_id = ?
                           AND screenshot_key = ?)`
        )
        .bind(
          now, input.source,
          tokenHash, userId, period, workspaceId, subscriptionId, now,
          subscriptionId, period, workspaceId, key
        ),
    ]);

    const payChanges = results[0]?.meta.changes ?? 0;
    const tokChanges = results[1]?.meta.changes ?? 0;
    committed = payChanges === 1 && tokChanges === 1;
  } catch (err) {
    // Ambiguous: the batch may have committed before the failure surfaced. The key is
    // unique, so a read-back tells us definitively whether D1 landed our write.
    const landed = await env.DB
      .prepare(
        "SELECT 1 AS ok FROM payments WHERE subscription_id = ? AND period = ? AND screenshot_key = ?"
      )
      .bind(subscriptionId, period, key)
      .first<{ ok: number }>()
      .catch(() => null);
    if (landed) {
      committed = true; // D1 committed; keep the object.
    } else {
      await deleteObject(env.BUCKET, key).catch(() => {});
      throw err;
    }
  }

  if (!committed) {
    await deleteObject(env.BUCKET, key); // compensation
    await throwSubmitError(env, tokenHash, userId, period, workspaceId, subscriptionId, now);
  }

  const row = await env.DB
    .prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ? AND screenshot_key = ?")
    .bind(subscriptionId, period, key)
    .first<{ id: number }>();
  return { paymentId: row!.id, screenshotKey: key };
}

export interface RecordProofInput {
  subscriptionId: number;
  workspaceId: number;
  userId: number;
  period: string;
  body: R2Body;
  ext: string;
  contentType: string;
  source: string; // e.g. "user_slash" | "admin_manual"
  paymentNote?: string | null;
}

/**
 * Store a proof and mark the payment paid WITHOUT a one-time token (Discord slash /
 * admin paths, where the channel already authenticates the user). Same R2 compensation
 * + read-back-before-delete guarantees as the token flow; only pending/rejected accept a
 * proof (no paid->paid).
 */
export async function recordProof(
  env: Env,
  input: RecordProofInput
): Promise<SubmitProofResult> {
  const { subscriptionId, workspaceId, userId, period } = input;
  await ensurePeriodPayment(env.DB, subscriptionId, period);
  const key = buildScreenshotKey(workspaceId, period, userId, input.ext, crypto.randomUUID());
  await putObject(env.BUCKET, key, input.body, input.contentType);
  const now = nowUtcIso();

  const landed = async () =>
    env.DB
      .prepare("SELECT 1 AS ok FROM payments WHERE subscription_id = ? AND period = ? AND screenshot_key = ?")
      .bind(subscriptionId, period, key)
      .first<{ ok: number }>()
      .catch(() => null);

  try {
    const res = await env.DB
      .prepare(
        `UPDATE payments
           SET status = 'paid', has_proof = 1, screenshot_key = ?,
               payment_note = COALESCE(?, payment_note),
               source = ?, submitted_at = ?, paid_at = ?, updated_at = ?
         WHERE subscription_id = ? AND period = ? AND workspace_id = ?
           AND status IN ('pending','rejected')`
      )
      .bind(key, input.paymentNote ?? null, input.source, now, now, now, subscriptionId, period, workspaceId)
      .run();
    if ((res.meta.changes ?? 0) !== 1 && !(await landed())) {
      await deleteObject(env.BUCKET, key);
      throw new NoEligiblePayment(subscriptionId, period);
    }
  } catch (err) {
    if (err instanceof NoEligiblePayment) throw err;
    if (!(await landed())) {
      await deleteObject(env.BUCKET, key).catch(() => {});
      throw err;
    }
  }

  const row = await env.DB
    .prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ? AND screenshot_key = ?")
    .bind(subscriptionId, period, key)
    .first<{ id: number }>();
  return { paymentId: row!.id, screenshotKey: key };
}

export interface DeclareInput {
  tokenHash: string;
  subscriptionId: number;
  workspaceId: number;
  userId: number;
  period: string;
  source: string; // "user_web"
  paymentNote?: string | null;
}

/**
 * Token-gated "paid, no proof" submission (web note-only path). Same one-time-token
 * guarantee as submitProofWithToken: a double-gated D1 batch where the payment UPDATE
 * fires only while the token is unused, and the token claim fires only once the payment
 * carries our unique paid_at marker — so both apply or neither, and the token can't be
 * spent twice. No R2 involved.
 */
export async function recordDeclaredWithToken(
  env: Env,
  input: DeclareInput
): Promise<{ paymentId: number }> {
  const { tokenHash, subscriptionId, workspaceId, userId, period } = input;
  await ensurePeriodPayment(env.DB, subscriptionId, period);
  const now = nowUtcIso();

  const results = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE payments
           SET status = 'paid', has_proof = 0,
               payment_note = COALESCE(?, payment_note),
               source = ?, submitted_at = ?, paid_at = ?, updated_at = ?
         WHERE subscription_id = ? AND period = ? AND workspace_id = ?
           AND status IN ('pending','rejected')
           AND EXISTS (SELECT 1 FROM upload_tokens t
                       WHERE t.token_hash = ? AND t.user_id = ? AND t.period = ?
                         AND t.workspace_id = ?
                         AND (t.subscription_id IS NULL OR t.subscription_id = ?)
                         AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?)`
      )
      .bind(
        input.paymentNote ?? null, input.source, now, now, now,
        subscriptionId, period, workspaceId,
        tokenHash, userId, period, workspaceId, subscriptionId, now
      ),
    env.DB
      .prepare(
        `UPDATE upload_tokens
           SET used_at = ?, used_by_source = ?
         WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
           AND (subscription_id IS NULL OR subscription_id = ?)
           AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           AND EXISTS (SELECT 1 FROM payments
                       WHERE subscription_id = ? AND period = ? AND workspace_id = ?
                         AND paid_at = ? AND status = 'paid')`
      )
      .bind(
        now, input.source,
        tokenHash, userId, period, workspaceId, subscriptionId, now,
        subscriptionId, period, workspaceId, now
      ),
  ]);

  const payChanges = results[0]?.meta.changes ?? 0;
  const tokChanges = results[1]?.meta.changes ?? 0;
  if (payChanges !== 1 || tokChanges !== 1) {
    await throwSubmitError(env, tokenHash, userId, period, workspaceId, subscriptionId, now);
  }
  const row = await env.DB
    .prepare("SELECT id FROM payments WHERE subscription_id = ? AND period = ?")
    .bind(subscriptionId, period)
    .first<{ id: number }>();
  return { paymentId: row!.id };
}

/** Decide which precise error to raise when the guarded batch didn't apply. */
async function throwSubmitError(
  env: Env,
  tokenHash: string,
  userId: number,
  period: string,
  workspaceId: number,
  subscriptionId: number,
  now: string
): Promise<never> {
  const tok = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM upload_tokens
       WHERE token_hash = ? AND user_id = ? AND period = ? AND workspace_id = ?
         AND (subscription_id IS NULL OR subscription_id = ?)
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, userId, period, workspaceId, subscriptionId, now)
    .first<{ ok: number }>();
  if (!tok) throw new TokenUnusable(tokenHash);
  throw new NoEligiblePayment(subscriptionId, period);
}
