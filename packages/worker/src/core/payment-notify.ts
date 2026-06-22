import type { Env } from "../env";
import { parseSettings } from "../env";

// Outbound notification when a member submits a payment that needs review. Two independent,
// optional targets configured in workspace settings (fire whichever is set):
//   • payment_bark_url    — a Bark/ntfy-style GET URL template (placeholders below)
//   • payment_webhook_url  — an incoming webhook (Discord / Google Chat / Slack / generic)
// Both carry an admin deep link to the submitted payment so the owner can tap straight to review.

export interface PaymentNotifyVars {
  payer: string; // member display name (raw, un-encoded)
  amount: string; // formatted total, e.g. "1,573"
  period: string; // e.g. "2026-06"
  admin_url: string; // deep link to the payment in the admin app (may be "" if ADMIN_ORIGIN unset)
}

const PLACEHOLDER_RE = /\{(payer|amount|period|admin_url)\}/g;
const TIMEOUT_MS = 1500;

/**
 * Fill a Bark/ntfy GET URL template, URL-encoding each value — the payer may be CJK and the
 * admin_url carries its own query string (Bark's ?url=...). Unknown placeholders are left as-is.
 */
export function buildBarkUrl(template: string, v: PaymentNotifyVars): string {
  return template.replace(PLACEHOLDER_RE, (_m, k: string) => encodeURIComponent(v[k as keyof PaymentNotifyVars]));
}

/**
 * Choose the JSON body for an incoming webhook by host so a pasted URL "just works":
 * Discord → {content}, Google Chat / Slack → {text}, anything else → a generic payload that
 * still carries the human message plus structured fields. An unparseable URL falls back to generic.
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
 * Best-effort: read the workspace's notification settings and fire the Bark URL and/or webhook.
 * Never throws and never blocks longer than TIMEOUT_MS per request — a misconfigured or slow
 * endpoint must not fail or stall the member's payment.
 */
export async function notifyPaymentSubmitted(env: Env, input: PaymentNotifyInput): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
      .bind(input.workspaceId).first<{ settings: string }>();
    if (!row) return;
    const s = parseSettings(row.settings);
    const bark = s.payment_bark_url.trim();
    const webhook = s.payment_webhook_url.trim();
    if (!bark && !webhook) return;

    const base = (env.ADMIN_ORIGIN ?? "").replace(/\/+$/, "");
    const adminUrl = base ? `${base}/#payments?id=${input.paymentId}` : "";
    const amountStr = input.amount.toLocaleString();
    const v: PaymentNotifyVars = { payer: input.payer, amount: amountStr, period: input.period, admin_url: adminUrl };
    const message =
      `💳 新繳費待審核：${input.payer} NT$${amountStr}（${input.period}・共 ${input.paidCount} 筆）` +
      (adminUrl ? `\n審核 → ${adminUrl}` : "");

    const jobs: Promise<unknown>[] = [];
    if (bark) jobs.push(send(buildBarkUrl(bark, v), { method: "GET" }));
    if (webhook) jobs.push(send(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pickWebhookBody(webhook, message, v, input.amount)),
    }));
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error("payment notify failed", e);
  }
}

async function send(url: string, init: RequestInit): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) { console.error("payment notify request failed", e); }
  finally { clearTimeout(t); }
}
