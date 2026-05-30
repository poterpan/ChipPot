import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("seed", () => {
  it("creates the club workspace with discord channel + billing_day 5", async () => {
    const ws = await env.DB.prepare(
      "SELECT name, channel_type, billing_day, settings FROM workspaces WHERE id = 1"
    ).first<{ name: string; channel_type: string; billing_day: number; settings: string }>();
    expect(ws?.channel_type).toBe("discord");
    expect(ws?.billing_day).toBe(5);
    const settings = JSON.parse(ws!.settings);
    expect(settings.timezone).toBe("Asia/Taipei");
    expect(settings.overdue_days).toBe(3);
    expect(settings.proof_retention_months).toBe(24);
    expect(settings.delete_discord_original_message).toBe(false);
  });

  it("seeds the three plans with correct TWD prices", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, provider, monthly_amount FROM plans WHERE workspace_id = 1 ORDER BY id"
    ).all<{ name: string; provider: string; monthly_amount: number }>();
    expect(results).toEqual([
      { name: "ChatGPT", provider: "openai", monthly_amount: 315 },
      { name: "Claude Standard", provider: "anthropic", monthly_amount: 251 },
      { name: "Claude Premium", provider: "anthropic", monthly_amount: 1258 },
    ]);
  });

  it("seeds example channel_tags", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM channel_tags WHERE workspace_id = 1"
    ).first<{ n: number }>();
    expect(row!.n).toBeGreaterThanOrEqual(1);
  });
});
