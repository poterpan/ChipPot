import { nowUtcIso } from "./time";

export type PaymentStatus = "pending" | "paid" | "verified" | "rejected";

export interface PaymentRow {
  id: number;
  workspace_id: number;
  subscription_id: number;
  period: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount: number;
  status: PaymentStatus;
  has_proof: number;
  screenshot_key: string | null;
  proof_deleted_at: string | null;
  payment_note: string | null;
  verified_channel_tag_id: number | null;
  declared_channel_tag_id: number | null;
  source: string;
  rejected_reason: string | null;
  submitted_at: string | null;
  paid_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

// Spec §5.5 state machine.
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ["paid", "verified", "rejected"],
  paid: ["verified", "rejected"],
  rejected: ["paid", "verified"],
  verified: ["pending"], // 撤回驗證：唯一出口，清空驗證欄位（見 unverifyPayment）
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Statuses that may transition INTO `to`. */
function allowedSources(to: PaymentStatus): PaymentStatus[] {
  return (Object.keys(PAYMENT_TRANSITIONS) as PaymentStatus[]).filter((from) =>
    PAYMENT_TRANSITIONS[from].includes(to)
  );
}

export class InvalidPaymentTransition extends Error {
  constructor(
    public readonly paymentId: number,
    public readonly to: PaymentStatus
  ) {
    super(`payment ${paymentId} cannot transition to '${to}'`);
    this.name = "InvalidPaymentTransition";
  }
}

export async function getPayment(
  db: D1Database,
  id: number
): Promise<PaymentRow | null> {
  return db.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<PaymentRow>();
}

/**
 * Atomic guarded transition: the UPDATE only matches when the row's current status
 * is one that may transition into `to`, so concurrent callers can't double-apply.
 * Throws InvalidPaymentTransition when nothing was updated.
 */
async function applyTransition(
  db: D1Database,
  id: number,
  to: PaymentStatus,
  setClause: string,
  binds: unknown[]
): Promise<PaymentRow> {
  const froms = allowedSources(to);
  const placeholders = froms.map(() => "?").join(",");
  const res = await db
    .prepare(
      `UPDATE payments SET status = ?, ${setClause}, updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`
    )
    .bind(to, ...binds, nowUtcIso(), id, ...froms)
    .run();
  if (res.meta.changes === 0) throw new InvalidPaymentTransition(id, to);
  return (await getPayment(db, id))!;
}

export interface MarkPaidOpts {
  hasProof: boolean;
  screenshotKey?: string | null;
  paymentNote?: string | null;
  source: string;
  submittedAt?: string;
}

/** User submitted (with or without proof). pending|rejected -> paid. */
export async function markPaid(
  db: D1Database,
  id: number,
  o: MarkPaidOpts
): Promise<PaymentRow> {
  const now = nowUtcIso();
  return applyTransition(
    db, id, "paid",
    "has_proof = ?, screenshot_key = ?, payment_note = ?, source = ?, submitted_at = ?, paid_at = ?",
    [
      o.hasProof ? 1 : 0,
      o.screenshotKey ?? null,
      o.paymentNote ?? null,
      o.source,
      o.submittedAt ?? now,
      now,
    ]
  );
}

export interface VerifyOpts {
  verifiedBy: string;
  verifiedChannelTagId?: number | null;
}

/** Admin confirmed. pending|paid|rejected -> verified. */
export async function verifyPayment(
  db: D1Database,
  id: number,
  o: VerifyOpts
): Promise<PaymentRow> {
  return applyTransition(
    db, id, "verified",
    "verified_by = ?, verified_channel_tag_id = ?, verified_at = ?",
    [o.verifiedBy, o.verifiedChannelTagId ?? null, nowUtcIso()]
  );
}

export interface VerifiedPair {
  before: PaymentRow;
  after: PaymentRow;
}

export interface VerifyUserPeriodOpts {
  workspaceId: number;
  userId: number;
  period: string;
  verifiedBy: string;
  /**
   * Awaited right after each row's transition commits and before the next row is touched, so the
   * caller can record commits as they happen. The sweep is NOT atomic (one guarded UPDATE per row),
   * so the return value is worthless when a later row hard-errors — everything already committed
   * would be invisible to the caller and end up with no audit trail at all. Throwing from here
   * aborts the sweep on purpose: if a committed row cannot be recorded, stopping beats sweeping
   * more rows we would not be able to record either.
   */
  onVerified?: (pair: VerifiedPair) => Promise<void> | void;
}

export interface VerifyUserPeriodResult {
  /** One entry per row actually verified, so the caller can audit each before/after. */
  verified: VerifiedPair[];
}

/**
 * 一鍵全部核准: verify every payment this member has in the period that is waiting for review
 * (status 'paid' — the 已繳待驗 queue). One member submit settles one row per active subscription
 * sharing one screenshot, so the owner should be able to approve them together.
 *
 * Deliberately narrower than the state machine allows: 'pending' means the member never submitted
 * for that bill (added after the settle, or a paused sub) and 'rejected' means the ball is in the
 * member's court, so neither is swept in — both stay verifiable one-by-one. Each row keeps its OWN
 * declared channel as the verified channel, exactly like single verify; a declared tag from another
 * workspace is dropped to NULL rather than failing the batch (the single-verify handler 400s on one,
 * so we must never store one either). Rows that lose the guarded UPDATE race to a concurrent verify
 * are silently skipped.
 *
 * The sweep is deliberately non-atomic — one guarded UPDATE per row, no transaction — so a hard D1
 * error partway through leaves the earlier rows committed and throws. Callers that must record every
 * commit (the admin route writes one audit row per payment) pass `onVerified` instead of relying on
 * the return value, which never arrives in that case.
 */
export async function verifyUserPeriod(
  db: D1Database,
  o: VerifyUserPeriodOpts
): Promise<VerifyUserPeriodResult> {
  const targets = await db
    .prepare(
      `SELECT p.id AS id FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'paid' AND s.user_id = ?
       ORDER BY p.id`
    )
    .bind(o.workspaceId, o.period, o.userId)
    .all<{ id: number }>();
  const ownTags = await db
    .prepare("SELECT id FROM channel_tags WHERE workspace_id = ?")
    .bind(o.workspaceId)
    .all<{ id: number }>();
  const tagIds = new Set(ownTags.results.map((t) => t.id));

  const verified: VerifiedPair[] = [];
  for (const { id } of targets.results) {
    const before = await getPayment(db, id);
    if (!before) continue;
    const declared = before.declared_channel_tag_id;
    const tagId = declared != null && tagIds.has(declared) ? declared : null;
    let after: PaymentRow;
    try {
      after = await verifyPayment(db, id, { verifiedBy: o.verifiedBy, verifiedChannelTagId: tagId });
    } catch (e) {
      if (e instanceof InvalidPaymentTransition) continue; // raced with another verify → skip
      throw e;
    }
    verified.push({ before, after });
    // Outside the try: an error from the hook is the caller's, never a race to swallow.
    await o.onVerified?.({ before, after });
  }
  return { verified };
}

export interface RejectOpts {
  rejectedReason?: string | null;
  verifiedBy?: string | null;
}

/** Admin rejected. pending|paid -> rejected. */
export async function rejectPayment(
  db: D1Database,
  id: number,
  o: RejectOpts
): Promise<PaymentRow> {
  return applyTransition(
    db, id, "rejected",
    "rejected_reason = ?, verified_by = ?",
    [o.rejectedReason ?? null, o.verifiedBy ?? null]
  );
}

/** Undo a verification: verified -> pending, clearing verification fields. */
export async function unverifyPayment(
  db: D1Database,
  id: number
): Promise<PaymentRow> {
  return applyTransition(
    db, id, "pending",
    "verified_by = NULL, verified_at = NULL, verified_channel_tag_id = NULL",
    []
  );
}

/** Override the amount for a single payment (caller writes the audit log). */
export async function overrideAmount(
  db: D1Database,
  id: number,
  amount: number
): Promise<PaymentRow> {
  await db
    .prepare("UPDATE payments SET amount = ?, updated_at = ? WHERE id = ?")
    .bind(amount, nowUtcIso(), id)
    .run();
  return (await getPayment(db, id))!;
}
