import { describe, expect, it, vi } from "vitest";
import { discordNotifier } from "../../src/adapters/discord/notify";
import type { ReceiptTarget } from "../../src/core/notify";

const env = { DISCORD_BOT_TOKEN: "tok" } as any;

const target = (discord_id: string | null): ReceiptTarget => ({
  user_id: 1, discord_id, user_name: "王小明", period: "2029-03",
  lines: [{ plan_name: "ChatGPT", amount: 315 }, { plan_name: "Claude Premium", amount: 1258 }],
  total: 1573,
});

function capture(status = 200) {
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response("{}", { status });
  }));
  return sent;
}

describe("sendPaymentReceipt", () => {
  it("reject: @s the member, states the reason, lists the bills and offers the pay button", async () => {
    const sent = capture();
    const ok = await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "reject", target("d1"), "金額不符，少 NT$100");
    vi.unstubAllGlobals();
    expect(ok).toBe(true);
    const body = sent[0];
    expect(body.content).toContain("<@d1>");
    expect(body.content).toContain("2029-03");
    expect(body.content).toContain("退回");
    expect(body.content).toContain("金額不符，少 NT$100");
    expect(body.content).toContain("NT$1,573");
    expect(body.components[0].components[0].custom_id).toBe("chippot:pay:7:v1");
    expect(body.allowed_mentions).toEqual({ parse: [], users: ["d1"] });
  });

  it("reject without a reason says so instead of printing null", async () => {
    const sent = capture();
    await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "reject", target("d1"), null);
    vi.unstubAllGlobals();
    expect(sent[0].content).toContain("管理員未填寫原因");
    expect(sent[0].content).not.toContain("null");
  });

  it("verify: confirms receipt and carries no pay button", async () => {
    const sent = capture();
    await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "verify", target("d1"), null);
    vi.unstubAllGlobals();
    expect(sent[0].content).toContain("已確認收到");
    expect(sent[0].content).toContain("NT$1,573");
    expect(sent[0].components).toBeUndefined();
  });

  it("falls back to a bold name (and no ping) for an unbound member", async () => {
    const sent = capture();
    await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "reject", target(null), "重複轉帳");
    vi.unstubAllGlobals();
    expect(sent[0].content).toContain("**王小明**");
    expect(sent[0].allowed_mentions).toEqual({ parse: [], users: [] });
  });

  // Notifier contract (#43): only a confirmed 2xx may be reported as delivered, so the caller can
  // release the receipt slot and let the member hear about this bill on a later attempt.
  it("returns false when Discord refuses the send", async () => {
    capture(502);
    const ok = await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "reject", target("d1"), "金額不符");
    vi.unstubAllGlobals();
    expect(ok).toBe(false);
  });
});
