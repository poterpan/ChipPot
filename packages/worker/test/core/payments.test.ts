import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canTransition, getPayment, markPaid, verifyPayment, rejectPayment,
  overrideAmount, InvalidPaymentTransition,
} from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9002; // distinct id-space; per-file isolation
let seq = 0;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "P", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, WS, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, "LinePay", "linepay", 1, TS),
  ]);
});

async function newPayment(status = "pending"): Promise<number> {
  seq += 1;
  const period = `2030-${String(seq).padStart(2, "0")}`;
  const res = await env.DB.prepare(
    `INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(WS, WS, period, `${period}-01`, `${period}-28`, `${period}-05`, 315, status, "cron", TS, TS).run();
  return res.meta.last_row_id as number;
}

describe("payment state machine", () => {
  it("canTransition follows the spec graph", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("rejected", "paid")).toBe(true);
    expect(canTransition("paid", "verified")).toBe(true);
    expect(canTransition("verified", "paid")).toBe(false);
    expect(canTransition("paid", "pending")).toBe(false);
    expect(canTransition("rejected", "rejected")).toBe(false);
  });

  it("markPaid records proof + paid_at and flips status", async () => {
    const id = await newPayment("pending");
    const p = await markPaid(env.DB, id, {
      hasProof: true, screenshotKey: "1/2030-01/9002/x.png", source: "user_web",
    });
    expect(p.status).toBe("paid");
    expect(p.has_proof).toBe(1);
    expect(p.screenshot_key).toBe("1/2030-01/9002/x.png");
    expect(p.source).toBe("user_web");
    expect(p.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markPaid with no proof keeps has_proof=0 and stores note", async () => {
    const id = await newPayment("pending");
    const p = await markPaid(env.DB, id, {
      hasProof: false, paymentNote: "轉帳了", source: "user_slash",
    });
    expect(p.status).toBe("paid");
    expect(p.has_proof).toBe(0);
    expect(p.screenshot_key).toBeNull();
    expect(p.payment_note).toBe("轉帳了");
  });

  it("verifyPayment sets verifier + channel tag", async () => {
    const id = await newPayment("paid");
    const p = await verifyPayment(env.DB, id, { verifiedBy: "owner@x", verifiedChannelTagId: WS });
    expect(p.status).toBe("verified");
    expect(p.verified_by).toBe("owner@x");
    expect(p.verified_channel_tag_id).toBe(WS);
    expect(p.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejected payment can be re-paid (rejected -> paid)", async () => {
    const id = await newPayment("pending");
    const r = await rejectPayment(env.DB, id, { rejectedReason: "看不到金額" });
    expect(r.status).toBe("rejected");
    expect(r.rejected_reason).toBe("看不到金額");
    const p = await markPaid(env.DB, id, { hasProof: true, screenshotKey: "k", source: "user_web" });
    expect(p.status).toBe("paid");
  });

  it("verified is terminal: markPaid throws InvalidPaymentTransition", async () => {
    const id = await newPayment("pending");
    await verifyPayment(env.DB, id, { verifiedBy: "owner@x" });
    await expect(
      markPaid(env.DB, id, { hasProof: true, screenshotKey: "k", source: "user_web" })
    ).rejects.toBeInstanceOf(InvalidPaymentTransition);
  });

  it("cannot reject a verified payment", async () => {
    const id = await newPayment("pending");
    await verifyPayment(env.DB, id, { verifiedBy: "owner@x" });
    await expect(
      rejectPayment(env.DB, id, { rejectedReason: "x" })
    ).rejects.toBeInstanceOf(InvalidPaymentTransition);
  });

  it("overrideAmount updates the amount", async () => {
    const id = await newPayment("pending");
    const p = await overrideAmount(env.DB, id, 300);
    expect(p.amount).toBe(300);
  });
});
