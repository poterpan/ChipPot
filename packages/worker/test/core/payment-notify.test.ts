import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildBarkUrl, pickWebhookBody, notifyPaymentSubmitted, type PaymentNotifyVars } from "../../src/core/payment-notify";
import { settleUserPeriod } from "../../src/core/storage";

const TS = "2026-05-01T00:00:00.000Z";
const WS_EMPTY = 70000, WS_BARK = 70001, WS_HOOK = 70002, WS_BOTH = 70003;

function ws(id: number, settings: object) {
  return env.DB
    .prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, "W", "o", "discord", 1, JSON.stringify(settings), TS, TS);
}

beforeAll(async () => {
  await env.DB.batch([
    ws(WS_EMPTY, {}),
    ws(WS_BARK, { payment_bark_url: "https://api.day.app/KEY/新繳費 {payer}/NT${amount} {period}?url={admin_url}" }),
    ws(WS_HOOK, { payment_webhook_url: "https://discord.com/api/webhooks/1/abc" }),
    ws(WS_BOTH, { payment_bark_url: "https://api.day.app/KEY/{payer}", payment_webhook_url: "https://chat.googleapis.com/v1/spaces/x" }),
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

describe("buildBarkUrl", () => {
  it("URL-encodes every value and drops the placeholders", () => {
    const out = buildBarkUrl("https://api.day.app/K/新繳費 {payer}/NT${amount} {period}?url={admin_url}", V);
    expect(out).toContain(encodeURIComponent("廖清筆"));
    expect(out).toContain(encodeURIComponent("1,573"));
    expect(out).toContain(encodeURIComponent("https://admin.x/#payments?id=9"));
    expect(out).not.toContain("{payer}");
    expect(out).not.toContain("{admin_url}");
    // the literal NT$ prefix stays; only {amount} is substituted
    expect(out).toContain("NT$" + encodeURIComponent("1,573"));
  });
  it("leaves unknown placeholders untouched", () => {
    expect(buildBarkUrl("x/{unknown}/{payer}", V)).toContain("{unknown}");
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

  it("Bark → one GET carrying the encoded payer and admin deep link", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.panspace.dev"), { workspaceId: WS_BARK, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(calls[0]!.url).toContain(encodeURIComponent("廖清筆"));
    expect(calls[0]!.url).toContain(encodeURIComponent("https://admin.panspace.dev/#payments?id=1234"));
  });

  it("Discord webhook → one POST with { content } including the review link", async () => {
    const calls = capture();
    await notifyPaymentSubmitted(envWith("https://admin.x"), { workspaceId: WS_HOOK, ...baseInput });
    vi.unstubAllGlobals();
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toContain("廖清筆");
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
