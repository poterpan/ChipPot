import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { writeAudit } from "../../src/core/audit";

describe("writeAudit", () => {
  it("inserts an audit row with JSON before/after and UTC ISO created_at", async () => {
    await writeAudit(env.DB, {
      workspaceId: 1,
      actor: "owner@example.com",
      action: "amount.override",
      entityType: "payment",
      entityId: 42,
      before: { amount: 315 },
      after: { amount: 300 },
    });

    const row = await env.DB.prepare(
      `SELECT actor, action, entity_type, entity_id, before_json, after_json, created_at
       FROM audit_logs WHERE entity_type = 'payment' AND entity_id = 42`
    ).first<{
      actor: string; action: string; entity_type: string; entity_id: number;
      before_json: string; after_json: string; created_at: string;
    }>();

    expect(row?.action).toBe("amount.override");
    expect(JSON.parse(row!.before_json)).toEqual({ amount: 315 });
    expect(JSON.parse(row!.after_json)).toEqual({ amount: 300 });
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("accepts null before/after", async () => {
    await writeAudit(env.DB, {
      workspaceId: 1,
      actor: "system",
      action: "proof.auto_delete",
      entityType: "payment",
      entityId: 7,
    });
    const row = await env.DB.prepare(
      "SELECT before_json, after_json FROM audit_logs WHERE entity_id = 7"
    ).first<{ before_json: string | null; after_json: string | null }>();
    expect(row?.before_json).toBeNull();
    expect(row?.after_json).toBeNull();
  });
});
