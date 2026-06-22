import type { Env } from "../env";
import { parseSettings } from "../env";
import { taipeiPeriod } from "./time";

// Outbound notification when a member submits a payment that needs review. Configured in workspace
// settings; fire whichever target is set (both optional):
//   • payment_bark_key     — a Bark device key; we build the push URL + a tappable review link
//   • payment_webhook_url  — an incoming webhook (Discord / Google Chat / Slack / generic)
// payment_notify_template customizes the message body; empty = the built-in default. The owner
// pastes a key/URL — never hand-builds a templated URL.

export interface PaymentNotifyVars {
  payer: string; // member display name (raw, un-encoded)
  amount: string; // formatted total, e.g. "1,258"
  period: string; // e.g. "2026-06"
  admin_url: string; // deep link to the payment in the admin app (may be "" if ADMIN_ORIGIN unset)
}

export const DEFAULT_NOTIFY_TEMPLATE = "💳 新繳費待審核：{payer} NT${amount}（{period}）";
const DEFAULT_BARK_SERVER = "https://api.day.app";
const PLACEHOLDER_RE = /\{(payer|amount|period|admin_url)\}/g;
const TIMEOUT_MS = 1500;

/** Fill {payer}{amount}{period}{admin_url} in a message template (values raw, not URL-encoded). */
export function renderMessage(template: string, v: PaymentNotifyVars): string {
  return template.replace(PLACEHOLDER_RE, (_m, k: string) => v[k as keyof PaymentNotifyVars]);
}

/**
 * Build a Bark push GET URL from a device key: {server}/{key}/{body}?url={clickUrl}. The body and
 * click URL are URL-encoded (body may be CJK; clickUrl carries its own query). Tapping the push
 * opens clickUrl (the review deep link).
 */
export function buildBarkUrl(server: string, key: string, body: string, clickUrl: string): string {
  const base = (server.trim() || DEFAULT_BARK_SERVER).replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(key)}/${encodeURIComponent(body)}`;
  return clickUrl ? `${url}?url=${encodeURIComponent(clickUrl)}` : url;
}

/**
 * Choose the JSON body for an incoming webhook by host so a pasted URL "just works":
 * Discord → {content}, Google Chat / Slack → {text}, anything else → a generic payload that still
 * carries the human message plus structured fields. An unparseable URL falls back to generic.
 */
export function pickWebhookBody(
  webhookUrl: string, message: string, v: PaymentNotifyVars, amountNumber: number
): Record<string, unknown> {
  let host = "";
  try { host = new URL(webhookUrl).hostname.toLowerCase(); } catch { host = ""; }
  if (host.endsWith("discord.com") || host.endsWith("discordapp.com")) return { content: message };
  if (host.endsWith("chat.googleapis.com") || host.endsWith("slack.com")) return { text: message };
  return { text: message, payer: v.payer, amount: amountNumber, period: v.period, admin_url: v.admin_url };
}

export interface PaymentNotifyInput {
  workspaceId: number;
  payer: string;
  amount: number; // raw total just settled
  period: string;
  paymentId: number; // first settled row — the deep link target
  paidCount: number;
}

/**
 * Best-effort: read the workspace's notification settings and fire the Bark push and/or webhook.
 * Never throws and never blocks longer than TIMEOUT_MS per request — a misconfigured or slow
 * endpoint must not fail or stall the member's payment.
 */
export async function notifyPaymentSubmitted(env: Env, input: PaymentNotifyInput): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
      .bind(input.workspaceId).first<{ settings: string }>();
    if (!row) return;
    const s = parseSettings(row.settings);
    const barkKey = s.payment_bark_key.trim();
    const webhook = s.payment_webhook_url.trim();
    if (!barkKey && !webhook) return;

    const base = (env.ADMIN_ORIGIN ?? "").replace(/\/+$/, "");
    const adminUrl = base ? `${base}/#payments?id=${input.paymentId}` : "";
    const amountStr = input.amount.toLocaleString();
    const v: PaymentNotifyVars = { payer: input.payer, amount: amountStr, period: input.period, admin_url: adminUrl };
    const template = s.payment_notify_template.trim() || DEFAULT_NOTIFY_TEMPLATE;
    const message = renderMessage(template, v);

    const jobs: Promise<unknown>[] = [];
    // Bark: the body is the message; the review link is the tappable ?url (not repeated in text).
    if (barkKey) jobs.push(send(buildBarkUrl(s.payment_bark_server, barkKey, message, adminUrl), { method: "GET" }));
    // Webhook: append the review link as text unless the template already places it.
    if (webhook) {
      const linkInTpl = /\{admin_url\}/.test(template);
      const text = message + (adminUrl && !linkInTpl ? `\n審核 → ${adminUrl}` : "");
      jobs.push(send(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pickWebhookBody(webhook, text, v, input.amount)),
      }));
    }
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error("payment notify failed", e);
  }
}

export interface TestNotifyInput {
  kind: "bark" | "webhook";
  barkKey?: string;
  barkServer?: string;
  webhookUrl?: string;
  template?: string; // optional custom message; empty = the built-in default
}
export interface TestNotifyResult { ok: boolean; status?: number; error?: string }

/**
 * Fire a single test notification using the values the admin just typed (not the saved settings),
 * so they can verify a target before saving. Unlike notifyPaymentSubmitted this RETURNS the
 * outcome (reached? what status?) so the UI can show success/failure.
 */
export async function sendTestNotification(env: Env, input: TestNotifyInput): Promise<TestNotifyResult> {
  const base = (env.ADMIN_ORIGIN ?? "").replace(/\/+$/, "");
  const adminUrl = base ? `${base}/#payments` : "";
  const v: PaymentNotifyVars = { payer: "測試成員", amount: (520).toLocaleString(), period: taipeiPeriod(), admin_url: adminUrl };
  const template = (input.template ?? "").trim() || DEFAULT_NOTIFY_TEMPLATE;
  const message = "【測試】" + renderMessage(template, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    if (input.kind === "bark") {
      const key = (input.barkKey ?? "").trim();
      if (!key) return { ok: false, error: "請先填 Bark 裝置金鑰" };
      const res = await fetch(buildBarkUrl(input.barkServer ?? "", key, message, adminUrl), { method: "GET", signal: ctl.signal });
      return { ok: res.ok, status: res.status };
    }
    const url = (input.webhookUrl ?? "").trim();
    if (!url) return { ok: false, error: "請先填 Webhook 網址" };
    const linkInTpl = /\{admin_url\}/.test(template);
    const text = message + (adminUrl && !linkInTpl ? `\n審核 → ${adminUrl}` : "");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pickWebhookBody(url, text, v, 520)),
      signal: ctl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "送出失敗" };
  } finally {
    clearTimeout(t);
  }
}

async function send(url: string, init: RequestInit): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) { console.error("payment notify request failed", e); }
  finally { clearTimeout(t); }
}
