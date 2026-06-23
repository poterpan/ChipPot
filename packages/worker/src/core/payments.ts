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
