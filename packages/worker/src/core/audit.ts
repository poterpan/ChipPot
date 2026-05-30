import { nowUtcIso } from "./time";

export interface AuditEntry {
  workspaceId: number;
  actor: string;
  action: string;
  entityType: string;
  entityId: number;
  before?: unknown;
  after?: unknown;
}

/** Append an audit_logs row. All admin mutations must call this. */
export async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
        (workspace_id, actor, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      e.workspaceId,
      e.actor,
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      nowUtcIso()
    )
    .run();
}
