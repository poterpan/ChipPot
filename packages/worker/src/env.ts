export interface Env {
  DB: D1Database;
  // Optional: omit the [[r2_buckets]] binding in wrangler.toml to run without screenshots.
  BUCKET?: R2Bucket;
  // Cloudflare Access (secrets / vars; set via wrangler secret put or .dev.vars).
  ACCESS_TEAM_DOMAIN?: string; // <team> in <team>.cloudflareaccess.com
  ACCESS_AUD?: string; // Access application AUD tag
  ACCESS_ALLOWED_EMAILS?: string; // optional comma-separated allowlist
  // Allowed browser origins for CORS (comma-separated; e.g. the Pages URLs).
  WEB_ORIGIN?: string;
  ADMIN_ORIGIN?: string;
  // Discord (secrets / vars; set via wrangler secret put or .dev.vars).
  DISCORD_PUBLIC_KEY?: string; // Ed25519 public key (hex) for interaction signatures
  DISCORD_BOT_TOKEN?: string;
  DISCORD_APPLICATION_ID?: string;
}

export interface WorkspaceSettings {
  timezone: string;
  discord_guild_id: string;
  discord_billing_channel_id: string;
  discord_payment_message_id: string;
  discord_bind_message_id: string;
  overdue_days: number;
  proof_retention_months: number;
  admin_discord_ids: string[];
  overdue_template: string;
  billing_opened_template: string;
  payment_message_template: string;
  // Outbound "a member submitted a payment" notifications (all optional, fire whichever is set).
  payment_bark_key: string; // Bark device key — we build the push URL + tappable review link
  payment_bark_server: string; // Bark server base (default https://api.day.app; for self-hosters)
  payment_webhook_url: string; // incoming webhook (Discord / Google Chat / Slack / generic); body shape by host
  payment_notify_template: string; // message body; empty = the built-in default
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  timezone: "Asia/Taipei",
  discord_guild_id: "",
  discord_billing_channel_id: "",
  discord_payment_message_id: "",
  discord_bind_message_id: "",
  overdue_days: 3,
  proof_retention_months: 24,
  admin_discord_ids: [],
  overdue_template: "⏰ **{period} 催繳**\n以下夥伴本期尚有未繳（共 {count} 位），請儘速處理 🙏\n{list}",
  billing_opened_template: "📢 **{period} 開始繳費**\n{plans}\n\n請點下方「繳費」按鈕，或使用 `/繳費` 指令（可附截圖）。",
  payment_message_template: "💳 **AI 訂閱繳費**\n點下方「繳費」按鈕選擇繳費渠道送出（一次涵蓋你所有訂閱），或使用 `/繳費` 指令（可附截圖／備註）。",
  payment_bark_key: "",
  payment_bark_server: "https://api.day.app",
  payment_webhook_url: "",
  payment_notify_template: "",
};

function intInRange(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`invalid settings number: ${String(v)}`);
  }
  return v;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function parseSettings(json: string): WorkspaceSettings {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    timezone: str(raw.timezone, DEFAULT_SETTINGS.timezone),
    discord_guild_id: str(raw.discord_guild_id, ""),
    discord_billing_channel_id: str(raw.discord_billing_channel_id, ""),
    discord_payment_message_id: str(raw.discord_payment_message_id, ""),
    discord_bind_message_id: str(raw.discord_bind_message_id, ""),
    overdue_days: intInRange(raw.overdue_days, DEFAULT_SETTINGS.overdue_days, 0, 60),
    proof_retention_months: intInRange(
      raw.proof_retention_months, DEFAULT_SETTINGS.proof_retention_months, 1, 600
    ),
    admin_discord_ids: strArray(raw.admin_discord_ids),
    overdue_template: str(raw.overdue_template, DEFAULT_SETTINGS.overdue_template),
    billing_opened_template: str(raw.billing_opened_template, DEFAULT_SETTINGS.billing_opened_template),
    payment_message_template: str(raw.payment_message_template, DEFAULT_SETTINGS.payment_message_template),
    payment_bark_key: str(raw.payment_bark_key, ""),
    payment_bark_server: str(raw.payment_bark_server, DEFAULT_SETTINGS.payment_bark_server),
    payment_webhook_url: str(raw.payment_webhook_url, ""),
    payment_notify_template: str(raw.payment_notify_template, ""),
  };
}
