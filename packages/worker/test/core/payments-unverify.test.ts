import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { unverifyPayment, InvalidPaymentTransition, PAYMENT_TRANSITIONS } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9110, SUB = 9110;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS,WS,"U",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,WS,"P","x",315,TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB,WS,WS,WS,"2027-01-01",5,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,verified_by,verified_at,verified_channel_tag_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9111,WS,SUB,"2027-01","2027-01-01","2027-01-31","2027-01-05",315,"verified","cron","admin",TS,1,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9112,WS,SUB,"2027-02","2027-02-01","2027-02-28","2027-02-05",315,"pending","cron",TS,TS),
  ]);
});

describe("unverifyPayment", () => {
  it("allows verified -> pending in the state machine", () => {
    expect(PAYMENT_TRANSITIONS.verified).toContain("pending");
  });
  it("reverts a verified payment to pending and clears verification fields", async () => {
    const after = await unverifyPayment(env.DB, 9111);
    expect(after.status).toBe("pending");
    expect(after.verified_by).toBeNull();
    expect(after.verified_at).toBeNull();
    expect(after.verified_channel_tag_id).toBeNull();
  });
  it("throws InvalidPaymentTransition on a non-verified payment", async () => {
    await expect(unverifyPayment(env.DB, 9112)).rejects.toBeInstanceOf(InvalidPaymentTransition);
  });
});
