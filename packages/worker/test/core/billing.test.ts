import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPeriodDates, ensurePeriodPayment, ensureFirstPayment } from "../../src/core/billing";
import { getPayment } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9003;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "Claude Standard", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, WS, "2026-05-10", 5, TS, TS),
  ]);
});

describe("billing", () => {
  it("buildPeriodDates computes month bounds + due date", () => {
    expect(buildPeriodDates("2026-05", 5)).toEqual({
      period_start: "2026-05-01", period_end: "2026-05-31", due_date: "2026-05-05",
    });
    expect(buildPeriodDates("2026-02", 28)).toEqual({
      period_start: "2026-02-01", period_end: "2026-02-28", due_date: "2026-02-28",
    });
  });

  it("ensurePeriodPayment creates a pending payment with plan amount + dates", async () => {
    const r = await ensurePeriodPayment(env.DB, WS, "2026-07");
    expect(r.created).toBe(true);
    const p = await getPayment(env.DB, r.paymentId);
    expect(p?.status).toBe("pending");
    expect(p?.amount).toBe(251);
    expect(p?.period_start).toBe("2026-07-01");
    expect(p?.period_end).toBe("2026-07-31");
    expect(p?.due_date).toBe("2026-07-05");
    expect(p?.source).toBe("cron");
  });

  it("ensurePeriodPayment is idempotent (UNIQUE subscription_id+period)", async () => {
    const r1 = await ensurePeriodPayment(env.DB, WS, "2026-08");
    const r2 = await ensurePeriodPayment(env.DB, WS, "2026-08");
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.paymentId).toBe(r1.paymentId);
  });

  it("ensureFirstPayment derives the period from start_date", async () => {
    const r = await ensureFirstPayment(env.DB, WS); // start_date 2026-05-10 -> 2026-05
    const p = await getPayment(env.DB, r.paymentId);
    expect(p?.period).toBe("2026-05");
    expect(p?.due_date).toBe("2026-05-05");
    expect(p?.amount).toBe(251);
  });

  it("throws for an unknown subscription", async () => {
    await expect(ensurePeriodPayment(env.DB, 123456, "2026-09")).rejects.toThrow();
  });
});
