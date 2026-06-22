import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildBarkUrl, renderMessage, pickWebhookBody, notifyPaymentSubmitted, sendTestNotification,
  DEFAULT_NOTIFY_TEMPLATE, type PaymentNotifyVars,
} from "../../src/core/payment-notify";
import { settleUserPeriod } from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const WS_EMPTY = 70000, WS_BARK = 70001, WS_HOOK = 70002, WS_BOTH = 70003, WS_CUSTOM = 70004;

function ws(id: number, settings: object) {
  return env.DB
    .prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, "W", "o", "discord", 1, JSON.stringify(settings), TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    ws(WS_EMPTY, {}),
    ws(WS_BARK, { payment_bark_key: "3hGxxKEY" }), // no server → default api.day.app
    ws(WS_HOOK, { payment_webhook_url: "https://discord.com/api/webhooks/1/abc" }),
    ws(WS_BOTH, { payment_bark_key: "K2", payment_webhook_url: "https://chat.googleapis.com/v1/spaces/x" }),
    ws(WS_CUSTOM, { payment_webhook_url: "https://discord.com/api/webhooks/1/abc", payment_notify_template: "自訂：{payer} 繳了 {amount}" }),
  ]);
});

function capture() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: unknown, init?: RequestInit) => {
    calls.push({ url: String(u), init });
    return new Response("{}", { status: 200 });
  }));
  return calls;
}

const baseInput = { payer: "廖清筆", amount: 1573, period: "2026-06", paymentId: 1234, paidCount: 2 };
const envWith = (origin: string | undefined) => ({ ...env, ADMIN_ORIGIN: origin }) as typeof env;

const V: PaymentNotifyVars = { payer: "廖清筆", amount: "1,573", period: "2026-06", admin_url: "https://admin.x/#payments?id=9" };

describe("renderMessage", () => {
  it("fills placeholders with raw (un-encoded) values", () => {
    expect(renderMessage("{payer} NT${amount}（{period}）", V)).toBe("廖清筆 NT$1,573（2026-06）");
  });
  it("substitutes {admin_url} when present", () => {
    expect(renderMessage("→ {admin_url}", V)).toBe("→ https://admin.x/#payments?id=9");
  });
});

describe("buildBarkUrl", () => {
  it("builds {server}/{key}/{body}?url={click}, encoding body and click link", () => {
    const out = buildBarkUrl("https://api.day.app", "KEY123", "💳 廖清筆 NT$1,573", "https://admin.x/#payments?id=9");
    expect(out.startsWith("https://api.day.app/KEY123/")).toBe(true);
    expect(out).toContain(encodeURIComponent("💳 廖清筆 NT$1,573"));
    expect(out).toContain("?url=" + encodeURIComponent("https://admin.x/#payments?id=9"));
  });
  it("defaults the server when blank and trims a trailing slash", () => {
    expect(buildBarkUrl("", "K", "hi", "")).toBe("https://api.day.app/K/" + encodeURIComponent("hi"));
    expect(buildBarkUrl("https://bark.me/", "K", "hi", "")).toBe("https://bark.me/K/" + encodeURIComponent("hi"));
  });
  it("omits ?url when there is no click link", () => {
    expect(buildBarkUrl("https://api.day.app", "K", "hi", "")).not.toContain("?url=");
  });
});

describe("pickWebhookBody", () => {
  it("Discord host → { content }", () => {
    expect(pickWebhookBody("https://discord.com/api/webhooks/1/x", "msg", V, 1573)).toEqual({ content: "msg" });
  });
  it("Discord ptb subdomain → { content }", () => {
    expect(pickWebhookBody("https://ptb.discord.com/api/webhooks/1/x", "m", V, 1)).toEqual({ content: "m" });
  });
  it("discordapp.com → { content }", () => {
    expect(pickWebhookBody("https://discordapp.com/api/webhooks/1/x", "m", V, 1)).toEqual({ content: "m" });
  });
  it("Google Chat → { text }", () => {
    expect(pickWebhookBody("https://chat.googleapis.com/v1/spaces/x", "m", V, 1)).toEqual({ text: "m" });
  });
  it("Slack → { text }", () => {
    expect(pickWebhookBody("https://hooks.slack.com/services/x", "m", V, 1)).toEqual({ text: "m" });
  });
  it("other host → generic payload with structured fields", () => {
    const b = pickWebhookBody("https://example.com/hook", "m", V, 1573);
    expect(b).toMatchObject({ text: "m", payer: "廖清筆", amount: 1573, period: "2026-06", admin_url: V.admin_url });
  });
  it("unparseable URL → generic payload", () => {
    expect(pickWebhookBody("not a url", "m", V, 1)).toMatchObject({ text: "m" });
  });
});

describe("notifyPaymentSubmitted", () => {
  it("fires nothing when neither target is configured", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.x"), { workspaceId: WS_EMPTY, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(0);
  });

  it("Bark → one GET to {default server}/{key}/... with encoded body + tappable review link", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.panspace.dev"), { workspaceId: WS_BARK, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    const u = calls[0]!.url;
    expect(u.startsWith("https://api.day.app/3hGxxKEY/")).toBe(true);
    expect(u).toContain(encodeURIComponent("廖清筆"));
    expect(u).toContain("?url=" + encodeURIComponent("https://admin.panspace.dev/#payments?id=1234"));
  });

  it("Discord webhook → one POST with { content } including the appended review link", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.x"), { workspaceId: WS_HOOK, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain("廖清筆");
    expect(body.content).toContain("審核 → https://admin.x/#payments?id=1234");
  });

  it("uses a custom notify template when set", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.x"), { workspaceId: WS_CUSTOM, ...baseInput });
    vi.unstubAllGlobals();
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain("自訂：廖清筆 繳了 1,573");
    expect(body.content).toContain("審核 → https://admin.x/#payments?id=1234");
  });

  it("both configured → two requests", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.x"), { workspaceId: WS_BOTH, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(2);
  });

  it("omits the link when ADMIN_ORIGIN is unset, still sends", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith(undefined), { workspaceId: WS_HOOK, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).not.toContain("審核 →");
  });

  it("the built-in default template is what ships when none is set", () => {
    expect(DEFAULT_NOTIFY_TEMPLATE).toContain("{payer}");
  });
});

describe("sendTestNotification", () => {
  it("Bark with a key → fires a GET to {server}/{key}/... and reports ok", async () => {
    const calls = capture();
    const r = await sendTestNotification(envWith("https://admin.x"), { kind: "bark", barkKey: "K9" });
    vi.unstubAllGlobals();
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(calls[0]!.url.startsWith("https://api.day.app/K9/")).toBe(true);
  });
  it("Bark without a key → no request, ok:false with a hint", async () => {
    const calls = capture();
    const r = await sendTestNotification(envWith("https://admin.x"), { kind: "bark", barkKey: "  " });
    vi.unstubAllGlobals();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("金鑰");
    expect(calls.length).toBe(0);
  });
  it("Webhook (Discord) → POST { content } marked as a test", async () => {
    const calls = capture();
    const r = await sendTestNotification(envWith("https://admin.x"), { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/1/x" });
    vi.unstubAllGlobals();
    expect(r.ok).toBe(true);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain("【測試】");
  });
  it("Webhook without a URL → no request, ok:false", async () => {
    const calls = capture();
    const r = await sendTestNotification(envWith("https://admin.x"), { kind: "webhook", webhookUrl: "" });
    vi.unstubAllGlobals();
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
  it("reports a non-2xx response as not ok, with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const r = await sendTestNotification(envWith("https://admin.x"), { kind: "bark", barkKey: "K" });
    vi.unstubAllGlobals();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });
});

describe("settleUserPeriod → payment notification wiring", () => {
  const WS = 70010, USER = 70011, SUB = 70012, PLAN = 70013;
  const PERIOD = "2027-09";
  beforeAll(async () => {
    await env.DB.batch([
      ws(WS, { payment_webhook_url: "https://discord.com/api/webhooks/9/z" }),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "阿明", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2027-01-01", 1, TS, TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-05`, 315, "pending", "cron", TS, TS),
    ]);
  });

  it("posts a webhook carrying the payer name, amount and the settled payment's deep link", async () => {
    const calls = capture();
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: USER, period: PERIOD, source: "user_slash",
      declaredChannelTagId: null, paymentNote: "test", proof: null,
    });
    vi.unstubAllGlobals();
    expect(r.paidCount).toBe(1);
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain("阿明");
    expect(body.content).toContain("NT$315");
    expect(body.content).toContain(`#payments?id=${r.paymentIds[0]}`);
  });
});

describe("settleUserPeriod — notification scheduled via waitUntil (Discord 3s budget)", () => {
  const WS = 70020, USER = 70021, SUB = 70022, PLAN = 70023;
  const PERIOD = "2027-11";
  beforeAll(async () => {
    await env.DB.batch([
      ws(WS, { payment_webhook_url: "https://discord.com/api/webhooks/9/z" }),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "阿華", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2027-01-01", 1, TS, TS),
      env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-05`, 315, "pending", "cron", TS, TS),
    ]);
  });

  it("hands the notification to waitUntil instead of awaiting it inline", async () => {
    const calls = capture();
    const scheduled: Promise<unknown>[] = [];
    const r = await settleUserPeriod(env, {
      workspaceId: WS, userId: USER, period: PERIOD, source: "user_slash",
      declaredChannelTagId: null, paymentNote: null, proof: null,
      waitUntil: (p) => { scheduled.push(p); },
    });
    expect(r.paidCount).toBe(1);
    expect(scheduled.length).toBe(1); // scheduled for the background, not awaited inline
    await Promise.all(scheduled); // drain the background work
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1); // the webhook still fired (in the background)
  });
});
