import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  // R2 is OPTIONAL in production (wrangler.toml's [[r2_buckets]] may be removed). The test
  // harness guarantees BUCKET regardless by injecting it via vitest.config.ts `miniflare.r2Buckets`
  // — decoupled from wrangler.toml — so the storage suite runs even on a fork that dropped R2.
  // The R2-absent runtime path is covered separately by tests that set `env.BUCKET = undefined`
  // (e.g. settle.test.ts, retention.test.ts, upload.test.ts, admin.test.ts).
  it("binds D1 and R2", () => {
    expect(env.DB).toBeDefined();
    expect(env.BUCKET).toBeDefined();
  });

  // A local `.dev.vars` (gitignored) supplies a REAL DISCORD_BOT_TOKEN, but CI has none.
  // If that token leaked into the test baseline, any code path gated on it (e.g.
  // billing/initiate → sendBillingOpened) would make a REAL Discord fetch locally while
  // CI silently takes the no-send branch — tests would behave differently per machine.
  // The setup file scrubs it; tests that exercise sending set their own dummy token.
  it("does not leak external secrets from .dev.vars into the test baseline", () => {
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  });
});
