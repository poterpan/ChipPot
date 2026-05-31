export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
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
  overdue_days: number;
  delete_discord_original_message: boolean;
  proof_retention_months: number;
  admin_discord_ids: string[];
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  timezone: "Asia/Taipei",
  discord_guild_id: "",
  discord_billing_channel_id: "",
  discord_payment_message_id: "",
  overdue_days: 3,
  delete_discord_original_message: false,
  proof_retention_months: 24,
  admin_discord_ids: [],
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
    overdue_days: intInRange(raw.overdue_days, DEFAULT_SETTINGS.overdue_days, 0, 60),
    delete_discord_original_message:
      typeof raw.delete_discord_original_message === "boolean"
        ? raw.delete_discord_original_message
        : DEFAULT_SETTINGS.delete_discord_original_message,
    proof_retention_months: intInRange(
      raw.proof_retention_months, DEFAULT_SETTINGS.proof_retention_months, 1, 600
    ),
    admin_discord_ids: strArray(raw.admin_discord_ids),
  };
}
