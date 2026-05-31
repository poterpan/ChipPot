import type { Env } from "../env";
import { nowUtcIso } from "./time";
import { ensureFirstPayment } from "./billing";

export interface RosterRow {
  name: string;
  email: string;
  plans: string[];
}

/** Split a simple CSV line on commas (the club roster has no quoted/embedded commas). */
function splitCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Parse a Google-Forms roster CSV: header `姓名,帳號,<plan name…>`. A row subscribes to a plan
 * column when its cell is "TRUE" (case-insensitive). Blank lines are skipped.
 */
export function parseRosterCsv(text: string): RosterRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const planCols = splitCsvLine(lines[0]!).slice(2);
  const rows: RosterRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const plans: string[] = [];
    planCols.forEach((col, idx) => {
      if ((cells[idx + 2] ?? "").toUpperCase() === "TRUE") plans.push(col);
    });
    rows.push({ name: cells[0] ?? "", email: cells[1] ?? "", plans });
  }
  return rows;
}

export interface ImportOptions {
  startDate: string; // YYYY-MM-DD; subscriptions' start (drives the first payment's period)
}

export interface ImportSummary {
  usersCreated: number;
  usersUpdated: number;
  subsCreated: number;
  subsSkipped: number;
  rowsSkipped: number;
  unmatchedPlans: string[];
}

/**
 * Upsert a roster: match users by email (update name, keep discord_id; else insert with
 * discord_id NULL), then for each TRUE plan ensure an active subscription (reusing
 * ensureFirstPayment to create the start-month pending payment). Idempotent.
 */
export async function importRoster(
  env: Env,
  workspaceId: number,
  rows: RosterRow[],
  opts: ImportOptions
): Promise<ImportSummary> {
  const now = nowUtcIso();
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(workspaceId).first<{ billing_day: number }>();
  const billingDay = wsRow?.billing_day ?? 5;
  const plans = await env.DB.prepare("SELECT id, name FROM plans WHERE workspace_id = ? AND active = 1").bind(workspaceId).all<{ id: number; name: string }>();
  const planByName = new Map(plans.results.map((p) => [p.name, p.id]));

  const summary: ImportSummary = { usersCreated: 0, usersUpdated: 0, subsCreated: 0, subsSkipped: 0, rowsSkipped: 0, unmatchedPlans: [] };
  const unmatched = new Set<string>();

  for (const row of rows) {
    if (!row.email) { summary.rowsSkipped++; continue; }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE workspace_id = ? AND email = ?").bind(workspaceId, row.email).first<{ id: number }>();
    let userId: number;
    if (existing) {
      await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").bind(row.name, now, existing.id).run();
      userId = existing.id;
      summary.usersUpdated++;
    } else {
      const res = await env.DB.prepare("INSERT INTO users (workspace_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(workspaceId, row.name, row.email, now, now).run();
      userId = res.meta.last_row_id as number;
      summary.usersCreated++;
    }

    for (const planName of row.plans) {
      const planId = planByName.get(planName);
      if (!planId) { unmatched.add(planName); continue; }
      const sub = await env.DB.prepare("SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND plan_id = ? AND status = 'active'").bind(workspaceId, userId, planId).first<{ id: number }>();
      if (sub) { summary.subsSkipped++; continue; }
      const ins = await env.DB.prepare(
        "INSERT INTO subscriptions (workspace_id, user_id, plan_id, start_date, billing_day, custom_cycle, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)"
      ).bind(workspaceId, userId, planId, opts.startDate, billingDay, now, now).run();
      await ensureFirstPayment(env.DB, ins.meta.last_row_id as number);
      summary.subsCreated++;
    }
  }

  summary.unmatchedPlans = [...unmatched];
  return summary;
}
