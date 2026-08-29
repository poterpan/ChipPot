import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const TABLES = [
  "workspaces", "users", "plans", "channel_tags", "subscriptions",
  "payments", "upload_tokens", "notification_logs", "audit_logs",
];

const TS = "2026-05-01T00:00:00.000Z";

// Storage isolation is per test FILE, so seed once and use a distinct id-space
// (9001) that never collides with the seeded workspace (id 1). Miniflare's D1
// enforces FOREIGN KEY constraints, so payments need real parents.
const WS = 9001;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_id, channel_type, billing_day, settings, created_at, updated_at)
       VALUES (?, 'W', 'owner', 'discord', 5, '{}', ?, ?)`
    ).bind(WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO users (id, workspace_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'U', ?, ?)`
    ).bind(WS, WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO plans (id, workspace_id, name, provider, monthly_amount, created_at, updated_at)
       VALUES (?, ?, 'P', 'openai', 315, ?, ?)`
    ).bind(WS, WS, TS, TS),
    env.DB.prepare(
      `INSERT INTO subscriptions (id, workspace_id, user_id, plan_id, start_date, billing_day, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-05-01', 5, ?, ?)`
    ).bind(WS, WS, WS, WS, TS, TS),
  ]);
});

// Each test uses a distinct period to avoid UNIQUE(subscription_id, period) collisions
// across `it` blocks within this file.
function insertPayment(status: string, period: string) {
  return env.DB.prepare(
    `INSERT INTO payments
       (workspace_id, subscription_id, period, period_start, period_end, due_date,
        amount, status, source, created_at, updated_at)
     VALUES (?, ?, ?, '2026-05-01', '2026-05-31', '2026-05-05', 315, ?, 'cron', ?, ?)`
  ).bind(WS, WS, period, status, TS, TS).run();
}

describe("schema", () => {
  it("creates all tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it("enforces payments status CHECK", async () => {
    await expect(insertPayment("BOGUS", "2026-01")).rejects.toThrow();
  });

  it("accepts a valid payments status", async () => {
    await expect(insertPayment("pending", "2026-02")).resolves.toBeDefined();
  });

  it("enforces UNIQUE(subscription_id, period) on payments", async () => {
    await insertPayment("pending", "2026-03");
    await expect(insertPayment("pending", "2026-03")).rejects.toThrow();
  });

  it("dedupes notification_logs via NOT NULL DEFAULT 0 sentinels", async () => {
    const ins = () =>
      env.DB.prepare(
        `INSERT INTO notification_logs (workspace_id, type, period, sent_at)
         VALUES (?, 'billing_opened', '2026-04', '2026-04-05T01:00:00.000Z')`
      ).bind(WS).run();
    await ins();
    await expect(ins()).rejects.toThrow(); // plan_id/user_id/subscription_id default to 0
  });

  // 0006 (#48) added `event` and put it in the UNIQUE; 0007 (#45) only widened the type CHECK.
  // The rebuild in 0007 must carry `event` across verbatim — an INSERT ... SELECT that wrote ''
  // instead would silently wipe the live overdue day-keys and degrade #48 back to one reminder
  // per period, with no error and no failing test anywhere.
  it("0006+0007 keep an event column that survives the rebuild", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(notification_logs)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("event");

    await env.DB.prepare(
      `INSERT INTO notification_logs (workspace_id, type, period, event, sent_at)
       VALUES (?, 'overdue', '2026-05', '2026-05-08', '2026-05-08T01:00:00.000Z')`
    ).bind(WS).run();
    const row = await env.DB.prepare(
      "SELECT event FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = '2026-05'"
    ).bind(WS).first<{ event: string }>();
    expect(row?.event).toBe("2026-05-08"); // not '' — the day-key is the dedup key
  });

  it("0007 allows the nudge type and dedupes per (entity, event)", async () => {
    await env.DB.prepare(
      `INSERT INTO notification_logs (workspace_id, type, period, user_id, sent_at)
       VALUES (?, 'nudge', '2026-06', 7, '2026-06-01T01:00:00.000Z')`
    ).bind(WS).run();

    // same day-key twice = one slot; a different event = a different slot
    const receipt = (event: string) =>
      env.DB.prepare(
        `INSERT INTO notification_logs (workspace_id, type, period, user_id, event, sent_at)
         VALUES (?, 'receipt', '2026-06', 7, ?, '2026-06-02T01:00:00.000Z')`
      ).bind(WS, event).run();
    await receipt("reject");
    await expect(receipt("reject")).rejects.toThrow(); // same event → deduped
    await expect(receipt("verify")).resolves.toBeDefined(); // different event → allowed
  });

  it("0004 adds declared_channel_tag_id and drops the screenshot_key unique index", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(payments)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("declared_channel_tag_id");

    const idx = await env.DB.prepare("PRAGMA index_list(payments)").all<{ name: string }>();
    expect(idx.results.map((i) => i.name)).not.toContain("idx_payments_screenshot_key");
  });
});
