import { describe, expect, it, vi } from "vitest";
import { discordNotifier } from "../../src/adapters/discord/notify";

const env = { DISCORD_BOT_TOKEN: "tok" } as any;

describe("sendPaymentNudge", () => {
  it("posts content with pay button and pins mentions to bound users only", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("{}", { status: 200 }); }));
    await discordNotifier.sendPaymentNudge(env, "chan-1", 7, "2027-07", [
      { user_id: 1, discord_id: "d1", user_name: "A", lines: [{ plan_name: "GPT", amount: 320 }], total: 320 },
    ]);
    vi.unstubAllGlobals();
    expect(body.content).toContain("2027-07");
    expect(body.content).toContain("<@d1>");
    expect(body.components[0].components[0].custom_id).toBe("chippot:pay:7:v1");
    expect(body.allowed_mentions.users).toEqual(["d1"]);
    expect(body.allowed_mentions.parse).toEqual([]);
  });
});
