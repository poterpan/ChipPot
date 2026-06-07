import type { Env } from "../env";
import { nowUtcIso, taipeiDate } from "./time";
import { writeAudit } from "./audit";

/** Subtract whole calendar months, clamping the day (May 31 − 1mo → Apr 30, not May 1). */
function subMonthsUtc(d: Date, months: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, lastDay));
  return r;
}

/**
 * Delete screenshots whose proof is older than `retentionMonths` (by verified_at, else
 * paid_at). Reconciliation data (amount/period/tag) is kept — only the image is removed
 * (spec §13). Returns the number of proofs cleared.
 *
 * Reference-counting: a single screenshot can be shared by several payments (one settlement
 * covers all of a user's subs). For each expired row we drop THIS row's screenshot_key first
 * (D1-first, so the row never re-appears), then delete the R2 object only when no OTHER
 * payment still references the key — never while a non-expired row still points at it.
 */
export async function runRetention(
  env: Env,
  workspaceId: number,
  retentionMonths: number,
  now: Date = new Date()
): Promise<number> {
  if (!env.BUCKET) return 0; // R2 not configured — nothing to retain
  const cutoffIso = subMonthsUtc(now, retentionMonths).toISOString();

  const { results } = await env.DB
    .prepare(
      `SELECT id, screenshot_key FROM payments
       WHERE workspace_id = ? AND screenshot_key IS NOT NULL
         AND COALESCE(verified_at, paid_at) IS NOT NULL
         AND COALESCE(verified_at, paid_at) < ?`
    )
    .bind(workspaceId, cutoffIso)
    .all<{ id: number; screenshot_key: string }>();

  let deleted = 0;
  for (const row of results) {
    try {
      // 1. Drop THIS payment's reference first (D1-first so this row never re-appears).
      //    Guard on the snapshotted key: if the row got a NEW proof since the SELECT, the
      //    UPDATE matches 0 rows and we skip — never nulling a fresher key.
      const upd = await env.DB
        .prepare("UPDATE payments SET screenshot_key = NULL, proof_deleted_at = ?, updated_at = ? WHERE id = ? AND screenshot_key = ?")
        .bind(taipeiDate(now), nowUtcIso(), row.id, row.screenshot_key)
        .run();
      if ((upd.meta.changes ?? 0) === 0) continue; // changed concurrently — leave it for next run
      // 2. Only delete the R2 object when no OTHER payment still references the key.
      const ref = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM payments WHERE screenshot_key = ?")
        .bind(row.screenshot_key)
        .first<{ c: number }>();
      if ((ref?.c ?? 0) === 0) {
        // D1-first ordering is required for ref-counting correctness; a rare R2 delete failure
        // here leaves an unreferenced object (logged below), not a dangling D1 reference.
        await env.BUCKET.delete(row.screenshot_key);
      }
      await writeAudit(env.DB, {
        workspaceId, actor: "system", action: "proof.auto_delete",
        entityType: "payment", entityId: row.id, before: { screenshot_key: row.screenshot_key },
      });
      deleted++;
    } catch (e) {
      console.error("retention failed for payment", row.id, e);
    }
  }
  return deleted;
}
