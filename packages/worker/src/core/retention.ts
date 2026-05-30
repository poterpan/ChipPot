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
 * (spec §13). Returns the number of proofs deleted.
 */
export async function runRetention(
  env: Env,
  workspaceId: number,
  retentionMonths: number,
  now: Date = new Date()
): Promise<number> {
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
    // R2-first: if the D1 update fails, screenshot_key stays set and the next run retries
    // (R2 delete is idempotent). Per-row guard so one failure doesn't abort the batch.
    try {
      await env.BUCKET.delete(row.screenshot_key);
      await env.DB
        .prepare("UPDATE payments SET screenshot_key = NULL, proof_deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(taipeiDate(now), nowUtcIso(), row.id)
        .run();
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
