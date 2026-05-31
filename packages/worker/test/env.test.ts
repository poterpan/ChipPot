import { describe, expect, it } from "vitest";
import { parseSettings, DEFAULT_SETTINGS } from "../src/env";

describe("parseSettings", () => {
  it("fills defaults for missing keys", () => {
    const s = parseSettings("{}");
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("overrides provided keys and coerces types", () => {
    const s = parseSettings(JSON.stringify({
      overdue_days: 5,
      proof_retention_months: 12,
      delete_discord_original_message: true,
      discord_guild_id: "123",
    }));
    expect(s.overdue_days).toBe(5);
    expect(s.proof_retention_months).toBe(12);
    expect(s.delete_discord_original_message).toBe(true);
    expect(s.discord_guild_id).toBe("123");
    expect(s.timezone).toBe("Asia/Taipei");
  });

  it("rejects out-of-range numbers", () => {
    expect(() => parseSettings(JSON.stringify({ overdue_days: -1 }))).toThrow();
    expect(() => parseSettings(JSON.stringify({ proof_retention_months: 0 }))).toThrow();
  });

  it("defaults the three notification templates and lets them be overridden", () => {
    const d = parseSettings("{}");
    expect(d.overdue_template).toContain("{list}");
    expect(d.billing_opened_template).toContain("{plans}");
    expect(d.payment_message_template).toContain("繳費");
    const s = parseSettings(JSON.stringify({ overdue_template: "欠 {total}" }));
    expect(s.overdue_template).toBe("欠 {total}");
    expect(s.billing_opened_template).toBe(d.billing_opened_template); // others keep default
  });

  it("parses admin_discord_ids as a string array, defaulting to []", () => {
    expect(parseSettings("{}").admin_discord_ids).toEqual([]);
    expect(parseSettings(JSON.stringify({ admin_discord_ids: ["123", "456"] })).admin_discord_ids)
      .toEqual(["123", "456"]);
    // non-string members are dropped; non-arrays fall back to []
    expect(parseSettings(JSON.stringify({ admin_discord_ids: ["123", 7, null] })).admin_discord_ids)
      .toEqual(["123"]);
    expect(parseSettings(JSON.stringify({ admin_discord_ids: "nope" })).admin_discord_ids).toEqual([]);
  });
});
