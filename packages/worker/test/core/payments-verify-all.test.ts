import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyUserPeriod, getPayment } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9500, OTHER_WS = 9599;
const U = 9500, U2 = 9501, PLAN = 9500;
const TAG = 9500, TAG2 = 9501, FOREIGN_TAG = 9599;
const SUB_TAG = 9510, SUB_NOTAG = 9511, SUB_PENDING = 9512, SUB_REJECTED = 9513,
      SUB_VERIFIED = 9514, SUB_FOREIGN = 9515, SUB_U2 = 9516, SUB_TAG2 = 9517;
const P_TAG = 9520, P_NOTAG = 9521, P_PENDING = 9522, P_REJECTED = 9523,
      P_VERIFIED = 9524, P_FOREIGN = 9525, P_OTHER_PERIOD = 9526, P_OTHER_USER = 9527,
      P_TAG2 = 9528;
const PERIOD = "2028-06";
const EMPTY_PERIOD = "2028-12";
const ACTOR = "owner@example.com";

function sub(id: number, userId: number) {
  return env.DB.prepare(
    `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, WS, userId, PLAN, "2028-01-01", 5, TS, TS);
}

function pay(id: number, subId: number, period: string, status: string, declaredTag: number | null,
             verifiedBy: string | null = null) {
  return env.DB.prepare(
    `INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,
        status,source,declared_channel_tag_id,verified_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, WS, subId, period, `${period}-01`, `${period}-30`, `${period}-05`, 315,
         status, "user_slash", declaredTag, verifiedBy, TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(OTHER_WS, "Other", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,sort_order,created_at) VALUES (?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", 0, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,sort_order,created_at) VALUES (?,?,?,?,?)`).bind(TAG2, WS, "銀行轉帳", 1, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,sort_order,created_at) VALUES (?,?,?,?,?)`).bind(FOREIGN_TAG, OTHER_WS, "別家渠道", 0, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U, WS, "阿明", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U2, WS, "小華", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    sub(SUB_TAG, U), sub(SUB_NOTAG, U), sub(SUB_PENDING, U), sub(SUB_REJECTED, U),
    sub(SUB_VERIFIED, U), sub(SUB_FOREIGN, U), sub(SUB_U2, U2), sub(SUB_TAG2, U),
    pay(P_TAG, SUB_TAG, PERIOD, "paid", TAG),
    pay(P_NOTAG, SUB_NOTAG, PERIOD, "paid", null),
    pay(P_PENDING, SUB_PENDING, PERIOD, "pending", null),
    pay(P_REJECTED, SUB_REJECTED, PERIOD, "rejected", TAG),
    pay(P_VERIFIED, SUB_VERIFIED, PERIOD, "verified", TAG, "admin"),
    pay(P_FOREIGN, SUB_FOREIGN, PERIOD, "paid", FOREIGN_TAG),
    pay(P_OTHER_PERIOD, SUB_TAG, "2028-07", "paid", TAG),
    pay(P_OTHER_USER, SUB_U2, PERIOD, "paid", TAG),
    pay(P_TAG2, SUB_TAG2, PERIOD, "paid", TAG2),
  ]);
});

describe("verifyUserPeriod (一鍵全部核准)", () => {
  it("verifies every 'paid' row of that member × period, each keeping its own declared channel", async () => {
    const r = await verifyUserPeriod(env.DB, { workspaceId: WS, userId: U, period: PERIOD, verifiedBy: ACTOR });
    expect(r.verified.map((v) => v.after.id).sort()).toEqual([P_TAG, P_NOTAG, P_FOREIGN, P_TAG2].sort());
    const withTag = await getPayment(env.DB, P_TAG);
    expect(withTag?.status).toBe("verified");
    expect(withTag?.verified_channel_tag_id).toBe(TAG);
    expect(withTag?.verified_by).toBe(ACTOR);
    // two rows in one batch declaring DIFFERENT channels each keep their own, not the batch's first
    expect((await getPayment(env.DB, P_TAG2))?.verified_channel_tag_id).toBe(TAG2);
    expect((await getPayment(env.DB, P_NOTAG))?.verified_channel_tag_id).toBeNull();
    // before/after pairs feed the per-payment audit entries the route writes
    expect(r.verified.every((v) => v.before.status === "paid" && v.after.status === "verified")).toBe(true);
  });

  it("drops a declared tag belonging to another workspace instead of storing it", async () => {
    const p = await getPayment(env.DB, P_FOREIGN);
    expect(p?.status).toBe("verified");
    expect(p?.verified_channel_tag_id).toBeNull();
  });

  it("leaves pending, rejected and already-verified rows untouched", async () => {
    expect((await getPayment(env.DB, P_PENDING))?.status).toBe("pending");
    expect((await getPayment(env.DB, P_REJECTED))?.status).toBe("rejected");
    expect((await getPayment(env.DB, P_VERIFIED))?.verified_by).toBe("admin"); // not re-stamped
  });

  it("never crosses into another period or another member", async () => {
    expect((await getPayment(env.DB, P_OTHER_PERIOD))?.status).toBe("paid");
    expect((await getPayment(env.DB, P_OTHER_USER))?.status).toBe("paid");
  });

  it("is idempotent: a second run finds nothing to verify", async () => {
    const r = await verifyUserPeriod(env.DB, { workspaceId: WS, userId: U, period: PERIOD, verifiedBy: ACTOR });
    expect(r.verified).toEqual([]);
  });

  it("returns an empty result for a period the member has no payments in", async () => {
    const r = await verifyUserPeriod(env.DB, { workspaceId: WS, userId: U, period: EMPTY_PERIOD, verifiedBy: ACTOR });
    expect(r.verified).toEqual([]);
  });
});
