import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimNotification, releaseNotification, releaseReceiptSlots } from "../../src/core/notify";

// Fresh id band for this file: workspace 9880. notification_logs has no foreign keys, so no
// parent rows are needed. (98xx bands already taken: 9800 billing-resend, 9810 overdue-preview,
// 9820 notifications-danger, 9830 initiate-preview, 9840 upload-gate, 9850 discord-initiate-cap,
// 9860 notify-send-failure, 9870 initiate-no-plans.)
const WS = 9880;
const P = "2029-01";

describe("notification slots", () => {
  it("claims once per (type, entity, event)", async () => {
    const k = { workspaceId: WS, type: "receipt" as const, period: P, userId: 1, subscriptionId: 11, event: "reject" };
    expect(await claimNotification(env.DB, k)).toBe(true);
    expect(await claimNotification(env.DB, k)).toBe(false);
  });

  it("treats a different event on the same bill as a different slot", async () => {
    const base = { workspaceId: WS, type: "receipt" as const, period: P, userId: 2, subscriptionId: 22 };
    expect(await claimNotification(env.DB, { ...base, event: "reject" })).toBe(true);
    expect(await claimNotification(env.DB, { ...base, event: "verify" })).toBe(true);
  });

  it("keeps the legacy period-wide slots working (no event)", async () => {
    const k = { workspaceId: WS, type: "billing_opened" as const, period: P };
    expect(await claimNotification(env.DB, k)).toBe(true);
    expect(await claimNotification(env.DB, k)).toBe(false);
  });

  it("accepts the nudge type and dedupes it per user", async () => {
    const k = { workspaceId: WS, type: "nudge" as const, period: P, userId: 3 };
    expect(await claimNotification(env.DB, k)).toBe(true);
    expect(await claimNotification(env.DB, k)).toBe(false);
  });

  it("releaseNotification frees exactly one event", async () => {
    const base = { workspaceId: WS, type: "receipt" as const, period: P, userId: 4, subscriptionId: 44 };
    await claimNotification(env.DB, { ...base, event: "reject" });
    await claimNotification(env.DB, { ...base, event: "verify" });
    expect(await releaseNotification(env.DB, { ...base, event: "reject" })).toBe(1);
    expect(await claimNotification(env.DB, { ...base, event: "reject" })).toBe(true);
    expect(await claimNotification(env.DB, { ...base, event: "verify" })).toBe(false);
  });

  it("releaseNotification without an event frees every event of that bill", async () => {
    const base = { workspaceId: WS, type: "receipt" as const, period: P, userId: 5, subscriptionId: 55 };
    await claimNotification(env.DB, { ...base, event: "reject" });
    await claimNotification(env.DB, { ...base, event: "verify" });
    expect(await releaseNotification(env.DB, base)).toBe(2);
  });

  it("releaseNotification is scoped to its workspace", async () => {
    const base = { type: "receipt" as const, period: P, userId: 7, subscriptionId: 77, event: "reject" };
    await claimNotification(env.DB, { ...base, workspaceId: WS });
    await claimNotification(env.DB, { ...base, workspaceId: WS + 1 });
    expect(await releaseNotification(env.DB, { ...base, workspaceId: WS })).toBe(1);
    expect(await claimNotification(env.DB, { ...base, workspaceId: WS + 1 })).toBe(false);
  });

  it("releaseReceiptSlots frees a member's whole period, across subscriptions", async () => {
    const a = { workspaceId: WS, type: "receipt" as const, period: P, userId: 6, subscriptionId: 61, event: "reject" };
    const b = { workspaceId: WS, type: "receipt" as const, period: P, userId: 6, subscriptionId: 62, event: "verify" };
    const other = { workspaceId: WS, type: "nudge" as const, period: P, userId: 6 };
    await claimNotification(env.DB, a);
    await claimNotification(env.DB, b);
    await claimNotification(env.DB, other);
    expect(await releaseReceiptSlots(env.DB, WS, P, 6)).toBe(2);
    // Only receipt slots are released — the nudge slot is a different conversation.
    expect(await claimNotification(env.DB, other)).toBe(false);
  });

  it("releaseReceiptSlots leaves other members and other periods alone", async () => {
    const mine = { workspaceId: WS, type: "receipt" as const, period: P, userId: 8, subscriptionId: 81, event: "reject" };
    const otherMember = { ...mine, userId: 9, subscriptionId: 91 };
    const otherPeriod = { ...mine, period: "2029-02" };
    await claimNotification(env.DB, mine);
    await claimNotification(env.DB, otherMember);
    await claimNotification(env.DB, otherPeriod);
    expect(await releaseReceiptSlots(env.DB, WS, P, 8)).toBe(1);
    expect(await claimNotification(env.DB, otherMember)).toBe(false);
    expect(await claimNotification(env.DB, otherPeriod)).toBe(false);
  });
});
