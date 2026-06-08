import { describe, expect, it, vi } from "vitest";
import { discordNotifier } from "../../src/adapters/discord/notify";
import type { OverduePerson, PlanOpenLine } from "../../src/core/notify";

const env = { DISCORD_BOT_TOKEN: "bot" } as any;

function captureFetch() {
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
    if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }));
  return sent;
}

describe("discordNotifier rendering", () => {
  it("renders the overdue template as ONE batched message tagging each person", async () => {
    const sent = captureFetch();
    const people: OverduePerson[] = [
      { user_id: 1, discord_id: "d1", user_name: "小明", lines: [{ plan_name: "ChatGPT", amount: 315 }, { plan_name: "Claude", amount: 1258 }], total: 1573 },
      { user_id: 2, discord_id: null, user_name: "小華", lines: [{ plan_name: "Claude", amount: 251 }], total: 251 },
    ];
    await discordNotifier.sendOverdue(env, "chan", "2026-06", people, "催繳 {period}（{count} 位）\n{list}");
    vi.unstubAllGlobals();
    expect(sent.length).toBe(1);
    const c = sent[0].content as string;
    expect(c).toContain("催繳 2026-06（2 位）");
    expect(c).toContain("<@d1>");          // bound → mention
    expect(c).toContain("**小華**");        // unbound → name
    expect(c).toContain("合計 NT$1,573");
  });

  it("renders the billing-opened template with {plans} and {total}", async () => {
    const sent = captureFetch();
    const lines: PlanOpenLine[] = [{ plan_id: 1, plan_name: "ChatGPT", amount: 315, role_id: "r1" }];
    await discordNotifier.sendBillingOpened(env, "chan", "2026-06", lines, "{period}\n{plans}\n共 {total}");
    vi.unstubAllGlobals();
    const c = sent[0].content as string;
    expect(c).toContain("<@&r1>");
    expect(c).toContain("共 315");
    expect(sent[0].components).toBeTruthy(); // pay button row present
  });

  it("de-dupes allowed_mentions.roles when two plans share a role (Discord rejects duplicate snowflakes)", async () => {
    const sent = captureFetch();
    // Standard + Premium both mapped to the same "Claude" role id.
    const lines: PlanOpenLine[] = [
      { plan_id: 1, plan_name: "Claude Standard", amount: 251, role_id: "claude" },
      { plan_id: 2, plan_name: "Claude Premium", amount: 1258, role_id: "claude" },
    ];
    await discordNotifier.sendBillingOpened(env, "chan", "2026-06", lines, "{period}\n{plans}");
    vi.unstubAllGlobals();
    const roles = sent[0].allowed_mentions.roles as string[];
    expect(roles).toEqual(["claude"]); // unique — no duplicate that would 400
    // Both plan lines still render their own mention in the content (display is per-plan).
    const c = sent[0].content as string;
    expect(c.match(/<@&claude>/g)?.length).toBe(2);
  });

  it("de-dupes allowed_mentions.users when a member appears twice in the overdue list", async () => {
    const sent = captureFetch();
    const people: OverduePerson[] = [
      { user_id: 1, discord_id: "d1", user_name: "小明", lines: [{ plan_name: "ChatGPT", amount: 315 }], total: 315 },
      { user_id: 1, discord_id: "d1", user_name: "小明", lines: [{ plan_name: "Claude", amount: 251 }], total: 251 },
    ];
    await discordNotifier.sendOverdue(env, "chan", "2026-06", people, "{period}\n{list}");
    vi.unstubAllGlobals();
    expect(sent[0].allowed_mentions.users as string[]).toEqual(["d1"]);
  });
});
