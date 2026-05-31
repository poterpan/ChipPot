# 後台增強 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add customizable notification templates, a one-click verify button in the payments list, and a push-status panel with resend/reset — and switch overdue reminders to one batched public message per period.

**Architecture:** A pure `renderTemplate` core fills `{placeholders}`; the Discord adapter keeps mention/role syntax and renders the three templates (stored in workspace settings). Overdue moves from per-payment to a per-period batch (`sendOverdueForPeriod`, shared by the daily cron and the admin resend), deduped per `(ws, period)`. New admin endpoints expose notification status + resend (force) + reset.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, Vitest + `@cloudflare/vitest-pool-workers`, Discord interactions, Vite + React admin SPA.

**Source spec:** `docs/superpowers/specs/2026-05-31-admin-enhancements-design.md`

---

## File Structure

**Worker — new files**
- `src/core/templates.ts` — `renderTemplate`.
- `test/core/templates.test.ts`, `test/adapters/discord-notify.test.ts`.

**Worker — modified files**
- `src/env.ts` — 3 template settings + defaults + parse.
- `src/core/notify.ts` — `OverduePerson` type, `Notifier` signatures (+template), drop `OverdueTarget`.
- `src/adapters/discord/notify.ts` — render the two templates; batched overdue.
- `src/core/scheduled.ts` — billing template; overdue → batched `sendOverdueForPeriod` (per distinct period).
- `src/core/billing.ts` — `initiateBillingOpened` passes the billing template + `opts.force`.
- `src/routes/admin.ts` — `GET/POST /admin/notifications*`; `discordPaymentMessage` uses the template.
- `packages/admin/src/api.ts`, `views/Settings.tsx`, `views/Payments.tsx`, `views/Dashboard.tsx`.

---

# PHASE 1 — Templates + overdue rework (core)

### Task 1: 3 template settings (env.ts)

**Files:**
- Modify: `packages/worker/src/env.ts`
- Test: `packages/worker/test/env.test.ts`

- [ ] **Step 1: Write the failing test** (append to `env.test.ts`)

```ts
it("defaults the three notification templates and lets them be overridden", () => {
  const d = parseSettings("{}");
  expect(d.overdue_template).toContain("{list}");
  expect(d.billing_opened_template).toContain("{plans}");
  expect(d.payment_message_template).toContain("繳費");
  const s = parseSettings(JSON.stringify({ overdue_template: "欠 {total}" }));
  expect(s.overdue_template).toBe("欠 {total}");
  expect(s.billing_opened_template).toBe(d.billing_opened_template); // others keep default
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test env`
Expected: FAIL — template fields undefined.

- [ ] **Step 3: Implement in `src/env.ts`**

Add to `WorkspaceSettings` (after `admin_discord_ids`):

```ts
  overdue_template: string;
  billing_opened_template: string;
  payment_message_template: string;
```

Add to `DEFAULT_SETTINGS` (after `admin_discord_ids: [],`):

```ts
  overdue_template: "⏰ **{period} 催繳**\n以下夥伴本期尚有未繳（共 {count} 位），請儘速處理 🙏\n{list}",
  billing_opened_template: "📢 **{period} 開始繳費**\n{plans}\n\n請點下方「繳費」按鈕，或使用 `/繳費` 指令（可附截圖）。",
  payment_message_template: "💳 **AI 訂閱繳費**\n點下方「繳費」按鈕選擇繳費渠道送出（一次涵蓋你所有訂閱），或使用 `/繳費` 指令（可附截圖／備註）。",
```

Add to the object returned by `parseSettings` (after `admin_discord_ids: strArray(raw.admin_discord_ids),`):

```ts
    overdue_template: str(raw.overdue_template, DEFAULT_SETTINGS.overdue_template),
    billing_opened_template: str(raw.billing_opened_template, DEFAULT_SETTINGS.billing_opened_template),
    payment_message_template: str(raw.payment_message_template, DEFAULT_SETTINGS.payment_message_template),
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/env.ts packages/worker/test/env.test.ts
git commit -m "feat(settings): customizable overdue/billing/payment-message templates"
```

---

### Task 2: `renderTemplate` (core/templates.ts)

**Files:**
- Create: `packages/worker/src/core/templates.ts`
- Test: `packages/worker/test/core/templates.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/core/templates";

describe("renderTemplate", () => {
  it("replaces known {keys} and leaves unknown ones untouched", () => {
    expect(renderTemplate("嗨 {name}，{period} 欠 {total}", { name: "小明", period: "2026-06", total: "1,258" }))
      .toBe("嗨 小明，2026-06 欠 1,258");
    expect(renderTemplate("{a}{b}", { a: "X" })).toBe("X{b}"); // unknown {b} kept
  });

  it("replaces every occurrence of a key", () => {
    expect(renderTemplate("{x}-{x}", { x: "7" })).toBe("7-7");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/templates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/templates.ts`**

```ts
/**
 * Fill `{key}` placeholders from `vars`. Unknown placeholders are left untouched (so a typo
 * in a user template degrades to visible text rather than silently vanishing). Pure string.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key]! : whole));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/templates.ts packages/worker/test/core/templates.test.ts
git commit -m "feat(core): renderTemplate placeholder substitution"
```

---

### Task 3: Notifier templates + batched overdue type (notify.ts + discord/notify.ts)

**Files:**
- Modify: `packages/worker/src/core/notify.ts`, `packages/worker/src/adapters/discord/notify.ts`
- Test: `packages/worker/test/adapters/discord-notify.test.ts` (create)

> This changes the `Notifier` interface, so `scheduled.ts` + `billing.ts` won't typecheck until Tasks 4–5. That's expected mid-phase (each task's own tests pass in isolation).

- [ ] **Step 1: Write the failing test** (`discord-notify.test.ts`)

```ts
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test discord-notify`
Expected: FAIL — signatures don't match / template not applied.

- [ ] **Step 3: Rewrite `src/core/notify.ts`** types + interface

Replace `OverdueTarget` with `OverduePerson` and update the `Notifier` interface:

```ts
export interface OverduePerson {
  user_id: number;
  discord_id: string | null;
  user_name: string;
  lines: { plan_name: string; amount: number }[];
  total: number;
}

/** Channel-agnostic notification sink (Discord impl in adapters/discord/notify.ts). */
export interface Notifier {
  sendBillingOpened(env: Env, channelId: string, period: string, lines: PlanOpenLine[], template: string): Promise<void>;
  sendOverdue(env: Env, channelId: string, period: string, people: OverduePerson[], template: string): Promise<void>;
}
```

(Keep `PlanOpenLine`, `NotificationKey`, `claimNotification` unchanged.)

- [ ] **Step 4: Rewrite `src/adapters/discord/notify.ts`**

```ts
import type { Env } from "../../env";
import type { Notifier, OverduePerson, PlanOpenLine } from "../../core/notify";
import { renderTemplate } from "../../core/templates";
import { createChannelMessage } from "./api";
import { payButtonRow } from "./commands";

/** Discord implementation of the channel-agnostic Notifier (spec §9). */
export const discordNotifier: Notifier = {
  async sendBillingOpened(env: Env, channelId, period, lines: PlanOpenLine[], template) {
    const plans = lines
      .map((l) => `${l.role_id ? `<@&${l.role_id}>` : `**${l.plan_name}**`}　${l.plan_name}：NT$${l.amount.toLocaleString()}`)
      .join("\n");
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const content = renderTemplate(template, { period, plans, total: total.toLocaleString() });
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow()],
      allowed_mentions: { parse: ["roles"] },
    });
  },

  async sendOverdue(env: Env, channelId, period, people: OverduePerson[], template) {
    const list = people
      .map((p) => {
        const mention = p.discord_id ? `<@${p.discord_id}>` : `**${p.user_name}**`;
        const plans = p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`).join("、");
        return `・${mention} ${plans}（合計 NT$${p.total.toLocaleString()}）`;
      })
      .join("\n");
    const content = renderTemplate(template, { period, count: String(people.length), list });
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      allowed_mentions: { parse: ["users"] },
    });
  },
};
```

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/worker && pnpm test discord-notify core/templates`
Expected: PASS (the two new suites). `pnpm typecheck` is RED on scheduled.ts/billing.ts until Tasks 4–5 — expected.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/notify.ts packages/worker/src/adapters/discord/notify.ts packages/worker/test/adapters/discord-notify.test.ts
git commit -m "feat(notify): template-driven messages; batched overdue (OverduePerson)"
```

---

### Task 4: Cron overdue → batched per period (`sendOverdueForPeriod`)

**Files:**
- Modify: `packages/worker/src/core/scheduled.ts`
- Test: `packages/worker/test/core/scheduled.test.ts`

- [ ] **Step 1: Update `scheduled.test.ts`** for the batched overdue + template signatures

Replace the mock notifier + the overdue assertions. The mock now records `(period, people, template)`:

```ts
const sent = { billing: [] as { period: string; lines: PlanOpenLine[] }[], overdue: [] as { period: string; people: OverduePerson[] }[] };
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.billing.push({ period, lines }); },
  async sendOverdue(_e, _ch, period, people, _t) { sent.overdue.push({ period, people }); },
};
```

Update the import: `import type { Notifier, PlanOpenLine, OverduePerson } from "../../src/core/notify";`

In the first test, replace the overdue assertion block with:

```ts
    // overdue: the 2026-06 pending payment (30 days late) reminded as one batched message
    expect(s.overdueSent).toBe(1);
    const od = sent.overdue.at(-1)!;
    expect(od.period).toBe("2026-06");
    expect(od.people[0]).toMatchObject({ discord_id: "d-9010" });
    expect(od.people[0]!.lines.length).toBeGreaterThanOrEqual(1);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/scheduled`
Expected: FAIL — `sendOverdueForPeriod` not present / signature mismatch.

- [ ] **Step 3: Rewrite the overdue section + billing template in `src/core/scheduled.ts`**

Update the import line:

```ts
import { claimNotification, type Notifier, type PlanOpenLine, type OverduePerson } from "./notify";
```

Pass the template in the billing-opened block — change the `notifier.sendBillingOpened` call:

```ts
          await notifier.sendBillingOpened(env, channelId, period, lines.results, settings.billing_opened_template);
```

Replace the whole overdue block (the `// 3. Overdue reminders:` section) with:

```ts
    // 3. Overdue reminders: one batched message per period that has overdue pending payments.
    if (canNotify) {
      const periods = await env.DB
        .prepare("SELECT DISTINCT period FROM payments WHERE workspace_id = ? AND status = 'pending'")
        .bind(ws.id)
        .all<{ period: string }>();
      for (const { period: pd } of periods.results) {
        if ((await sendOverdueForPeriod(env, ws.id, pd, notifier, { force: false, now })) > 0) summary.overdueSent++;
      }
    }
```

Add the exported helper at the end of the file:

```ts
/**
 * Send the overdue reminder for ONE period as a single batched public message listing every
 * unpaid member (tag once + their plans + total), deduped per (ws, period). Cron uses
 * force=false (only fires when ≥1 member is past overdue_days, claim-then-send). The admin
 * resend uses force=true (lists ALL unpaid members regardless of overdue_days; clears the
 * dedup slot first so it always re-sends). Returns the number of members notified (0 = nothing
 * sent / already sent / can't notify).
 */
export async function sendOverdueForPeriod(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { force: boolean; now?: Date }
): Promise<number> {
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return 0;
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return 0;
  const today = taipeiDate(opts.now ?? new Date());

  const rows = await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
              p.amount AS amount, p.due_date AS due_date, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status = 'pending'
       ORDER BY u.id, pl.id`
    )
    .bind(workspaceId, period)
    .all<{ user_id: number; discord_id: string | null; user_name: string; amount: number; due_date: string; plan_name: string }>();

  const byUser = new Map<number, OverduePerson & { overdue: boolean }>();
  for (const r of rows.results) {
    let e = byUser.get(r.user_id);
    if (!e) { e = { user_id: r.user_id, discord_id: r.discord_id, user_name: r.user_name, lines: [], total: 0, overdue: false }; byUser.set(r.user_id, e); }
    e.lines.push({ plan_name: r.plan_name, amount: r.amount });
    e.total += r.amount;
    if (daysBetween(r.due_date, today) >= settings.overdue_days) e.overdue = true;
  }

  const people = [...byUser.values()]
    .filter((p) => opts.force || p.overdue)
    .map(({ overdue, ...p }) => p);
  if (people.length === 0) return 0;

  if (opts.force) {
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period).run();
  }
  if (!(await claimNotification(env.DB, { workspaceId, type: "overdue", period }))) return 0;
  await notifier.sendOverdue(env, channelId, period, people, settings.overdue_template);
  return people.length;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/scheduled`
Expected: PASS (both scheduled tests). `pnpm typecheck` still RED on billing.ts until Task 5.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/scheduled.ts packages/worker/test/core/scheduled.test.ts
git commit -m "feat(cron): overdue = one batched message per period; sendOverdueForPeriod + billing template"
```

---

### Task 5: `initiateBillingOpened` — billing template + `force`

**Files:**
- Modify: `packages/worker/src/core/billing.ts`
- Test: `packages/worker/test/core/billing-initiate.test.ts`

- [ ] **Step 1: Update `billing-initiate.test.ts`** — the mock notifier signature + a force test

Update the mock notifier:

```ts
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.push({ period, lines }); },
  async sendOverdue() {},
};
```

Add a test (after the existing two):

```ts
it("force re-sends even after the slot was already claimed", async () => {
  // first call claims + sends
  await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
  const before = sent.length;
  // a normal second call would NOT send (slot taken)
  const r2 = await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
  expect(r2.sent).toBe(false);
  // force clears the slot and re-sends
  const r3 = await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier, { force: true });
  expect(r3.sent).toBe(true);
  expect(sent.length).toBe(before + 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/billing-initiate`
Expected: FAIL — `force` arg not accepted; sendBillingOpened arity.

- [ ] **Step 3: Implement in `src/core/billing.ts`**

Change the signature + add force handling + pass the template. Replace the function signature line:

```ts
export async function initiateBillingOpened(
  env: Env,
  workspaceId: number,
  period: string,
  input: InitiateInput,
  actor: string,
  notifier: Notifier,
  opts?: { force?: boolean }
): Promise<InitiateResult> {
```

In the notify section, before the `claimNotification`, add the force clear; and pass the template. Replace the notify block:

```ts
  // Notify (claim the shared billing_opened slot — cron uses the same key).
  const ws = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  const settings = parseSettings(ws!.settings);
  const channelId = settings.discord_billing_channel_id;
  let sent = false;
  if (channelId && env.DISCORD_BOT_TOKEN) {
    if (opts?.force) {
      await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?")
        .bind(workspaceId, period).run();
    }
    if (await claimNotification(env.DB, { workspaceId, type: "billing_opened", period })) {
      const lines: PlanOpenLine[] = subs.results
        .map((s) => planById.get(s.plan_id))
        .filter((p): p is NonNullable<typeof p> => !!p && p.active === 1)
        .filter((p, i, arr) => arr.findIndex((q) => q.id === p.id) === i)
        .map((p) => ({
          plan_id: p.id, plan_name: p.name, role_id: p.discord_role_id,
          amount: amountByPlan.get(p.id) ?? p.monthly_amount,
        }));
      if (lines.length > 0) {
        await notifier.sendBillingOpened(env, channelId, period, lines, settings.billing_opened_template);
        sent = true;
      }
    }
  }
```

(The old code used `parseSettings(ws!.settings).discord_billing_channel_id` inline — replace with the `settings` variable above. Remove the now-duplicate channelId line.)

- [ ] **Step 4: Run to verify pass + FULL typecheck (now green)**

Run: `cd packages/worker && pnpm test core/billing-initiate && pnpm typecheck`
Expected: PASS; typecheck clean (all interface callers updated). Also run the Discord modal-submit test which calls initiateBillingOpened: `pnpm test discord-initiate` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/billing.ts packages/worker/test/core/billing-initiate.test.ts
git commit -m "feat(core): initiateBillingOpened uses billing template + force re-send"
```

---

### ✅ Phase 1 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test && pnpm typecheck` — all green.
- [ ] **Codex review** (foreground):
  > Review ChipPot admin-enhancements Phase 1. Files: packages/worker/src/core/templates.ts, src/core/notify.ts, src/adapters/discord/notify.ts, src/core/scheduled.ts (sendOverdueForPeriod + cron overdue), src/core/billing.ts (initiateBillingOpened force). Verify: renderTemplate leaves unknown placeholders intact and can't break on special chars; overdue is now ONE batched message per period deduped per (ws,period); sendOverdueForPeriod's force path clears the slot then re-sends (and lists all unpaid), the non-force path only fires when ≥1 member is past overdue_days and claim-then-send dedupes; the cron iterating distinct periods can't double-send a period; initiateBillingOpened force clears the billing_opened slot before claiming. Flag any dedup race, double-send, or template-injection issue.
- [ ] Address findings one at a time, test each.

---

# PHASE 2 — Admin API (notifications status / resend / reset)

### Task 6: `GET/POST /admin/notifications*`

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: Add the failing tests** (append a `describe` to `admin.test.ts`)

```ts
describe("admin notifications", () => {
  it("reports status, resends (force), and resets", async () => {
    // make a pending payment for a fresh period so overdue resend has a target
    const u = await call("POST", "/admin/users", { display_name: "Notif", discord_id: "d-notif" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2028-03-01" });
    expect(s!.status).toBe(201);

    // status: nothing sent yet
    let st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.billing_opened).toBeNull();
    expect(st.overdue).toBeNull();

    // resend overdue (force) → sends, count >= 1, status now shows sent_at
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: "2028-03" });
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as any).count).toBeGreaterThanOrEqual(1);
    st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.overdue?.sent_at).toBeTruthy();

    // reset overdue → deletes the log
    const rs = await call("POST", "/admin/notifications/reset", { type: "overdue", period: "2028-03" });
    expect(((await rs!.json()) as any).deleted).toBeGreaterThanOrEqual(1);
    st = (await (await call("GET", "/admin/notifications?period=2028-03"))!.json()) as any;
    expect(st.overdue).toBeNull();
  });

  it("validates type and period", async () => {
    expect((await call("POST", "/admin/notifications/resend", { type: "bogus", period: "2028-03" }))!.status).toBe(400);
    expect((await call("POST", "/admin/notifications/reset", { type: "overdue", period: "bad" }))!.status).toBe(400);
  });
});
```

> NOTE: the test workspace (id 1) needs `discord_billing_channel_id` set and `env.DISCORD_BOT_TOKEN` present for a force-resend to actually send. The admin.test file already sets `discord_billing_channel_id` to "chan-1" in the "creates/rebuilds the persistent Discord payment message" test, and `.dev.vars` provides `DISCORD_BOT_TOKEN`. If the resend test runs before that one, add `await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-1" } });` at the start of the resend test, and stub fetch with `vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))` around the resend call.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement in `src/routes/admin.ts`**

Add imports:

```ts
import { sendOverdueForPeriod } from "../core/scheduled";
```

Add handlers (near `membersImport`):

```ts
const NOTIF_TYPES = ["billing_opened", "overdue"] as const;

async function notificationsStatus(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const period = ctx.url.searchParams.get("period") ?? taipeiPeriod();
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const row = async (type: string) =>
    env.DB.prepare("SELECT sent_at FROM notification_logs WHERE workspace_id = ? AND type = ? AND period = ? ORDER BY sent_at DESC LIMIT 1")
      .bind(ws, type, period).first<{ sent_at: string }>();
  return json({ billing_opened: await row("billing_opened"), overdue: await row("overdue") });
}

async function notificationsResend(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string }>(req);
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  let result: { sent?: boolean; count?: number };
  if (b.type === "billing_opened") {
    const r = await initiateBillingOpened(env, ws, period, { amounts: [] }, actorOf(ctx), discordNotifier, { force: true });
    result = { sent: r.sent };
  } else {
    const count = await sendOverdueForPeriod(env, ws, period, discordNotifier, { force: true });
    result = { count };
  }
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.resend", entityType: "workspace", entityId: ws, after: { type: b.type, period, ...result } });
  return json({ ok: true, ...result });
}

async function notificationsReset(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string }>(req);
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const res = await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = ? AND period = ?")
    .bind(ws, b.type, period).run();
  const deleted = res.meta.changes ?? 0;
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.reset", entityType: "workspace", entityId: ws, after: { type: b.type, period, deleted } });
  return json({ ok: true, deleted });
}
```

Register the routes in `buildAdminRouter()`:

```ts
    .get("/admin/notifications", notificationsStatus)
    .post("/admin/notifications/resend", notificationsResend)
    .post("/admin/notifications/reset", notificationsReset)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test routes/admin && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin-api): notification status + force-resend + reset"
```

---

### Task 7: `discordPaymentMessage` uses the template

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`

- [ ] **Step 1: Update `discordPaymentMessage`** — render the persistent-message body from the template. Add `taipeiPeriod` is already imported. Replace the `body` content line:

```ts
  const settings = parseSettings(row.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return errorResponse(400, "discord_billing_channel_id is not set");
  if (!env.DISCORD_BOT_TOKEN) return errorResponse(400, "bot token not configured");

  const body = {
    content: renderTemplate(settings.payment_message_template, { period: taipeiPeriod() }),
    components: [payButtonRow(ws)],
  };
```

Add the import:

```ts
import { renderTemplate } from "../core/templates";
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/routes/admin.ts
git commit -m "feat(admin): persistent payment message uses payment_message_template"
```

---

### ✅ Phase 2 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test routes/admin && pnpm typecheck` — green.
- [ ] **Codex review** (foreground):
  > Review ChipPot admin-enhancements Phase 2. File: packages/worker/src/routes/admin.ts (notificationsStatus/Resend/Reset + discordPaymentMessage template). Verify type/period validation, that resend(billing_opened) uses initiateBillingOpened force and resend(overdue) uses sendOverdueForPeriod force, reset deletes only the matching (ws,type,period) logs, actor = Access email, and the status query returns the latest sent_at or null. Flag any validation gap or wrong-workspace leak (wsId() is constant 1).
- [ ] Address findings, test each.

---

# PHASE 3 — Admin UI + deploy

### Task 8: Settings — 3 template textareas

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx`

- [ ] **Step 1: Add template state + load + save** in `Settings()`

After the existing `const [adminIds, setAdminIds] = useState("");` add:

```tsx
  const [tplOverdue, setTplOverdue] = useState("");
  const [tplBilling, setTplBilling] = useState("");
  const [tplMessage, setTplMessage] = useState("");
```

In the `useEffect` after `setAdminIds(...)`:

```tsx
    setTplOverdue(w.settings.overdue_template ?? "");
    setTplBilling(w.settings.billing_opened_template ?? "");
    setTplMessage(w.settings.payment_message_template ?? "");
```

In `save()`'s settings payload, add:

```tsx
          overdue_template: tplOverdue,
          billing_opened_template: tplBilling,
          payment_message_template: tplMessage,
```

- [ ] **Step 2: Render the textareas** — add inside the card, after the `admin_discord_ids` field (before the 刪除原始訊息 checkbox):

```tsx
        <Field label="逾期催繳文字（{period} {count} {list}）">
          <textarea value={tplOverdue} onChange={(e) => setTplOverdue(e.target.value)} disabled={busy} rows={4} style={{ width: "100%", fontFamily: "inherit" }} />
        </Field>
        <Field label="開繳通知文字（{period} {plans} {total}）">
          <textarea value={tplBilling} onChange={(e) => setTplBilling(e.target.value)} disabled={busy} rows={4} style={{ width: "100%", fontFamily: "inherit" }} />
        </Field>
        <Field label="常駐繳費訊息文字（{period}）">
          <textarea value={tplMessage} onChange={(e) => setTplMessage(e.target.value)} disabled={busy} rows={3} style={{ width: "100%", fontFamily: "inherit" }} />
        </Field>
```

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/admin && pnpm typecheck && pnpm build`
Expected: PASS; build OK.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Settings.tsx
git commit -m "feat(admin): editable notification templates in Settings"
```

---

### Task 9: Payments — one-click quick-verify

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx`

- [ ] **Step 1: Add a verify cell to the list row.** In the `Payments()` table, add a header `<th></th>` at the end of the `<thead>` row, and in each row add (after the source `<td>`):

```tsx
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  {["pending", "paid", "rejected"].includes(p.status) && (
                    <QuickVerify id={p.id} onDone={reload} />
                  )}
                </td>
```

Bump the loading/empty `colSpan` from 7 to 8.

- [ ] **Step 2: Add the `QuickVerify` component** (above `PaymentDetail`):

```tsx
function QuickVerify({ id, onDone }: { id: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  async function run() {
    setBusy(true); setErr(false);
    try { await api.verify(id, null); onDone(); }
    catch { setErr(true); setBusy(false); }
  }
  return (
    <button className="btn" disabled={busy} onClick={run} title="標記已驗證（帶入申報渠道）">
      {busy ? "…" : err ? "✗ 重試" : "✅ 驗證"}
    </button>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/admin && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): one-click quick-verify in the payments list"
```

---

### Task 10: Dashboard — push-status panel

**Files:**
- Modify: `packages/admin/src/api.ts`, `packages/admin/src/views/Dashboard.tsx`

- [ ] **Step 1: Add api methods** to `packages/admin/src/api.ts` (inside the `api` object):

```ts
  notifications: (period: string) => req<{ billing_opened: { sent_at: string } | null; overdue: { sent_at: string } | null }>("GET", `/notifications${qs({ period })}`),
  resendNotification: (type: string, period: string) => req<{ sent?: boolean; count?: number }>("POST", "/notifications/resend", { type, period }),
  resetNotification: (type: string, period: string) => req<{ deleted: number }>("POST", "/notifications/reset", { type, period }),
```

- [ ] **Step 2: Add the panel** to `Dashboard.tsx` — render `<PushStatus period={period} />` after the `各方案` card (inside the `data &&` block), and add the component + import `useAsync` is already imported; add `Card` is imported:

```tsx
function PushStatus({ period }: { period: string }) {
  const { data, reload } = useAsync(() => api.notifications(period), [period]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key); setMsg(null);
    try { await fn(); reload(); setMsg("✓ 完成"); } catch (e) { setMsg((e as Error).message); }
    setBusy(null);
  }
  const Row = ({ label, type, sentAt }: { label: string; type: string; sentAt: string | null | undefined }) => (
    <tr>
      <td>{label}</td>
      <td className="mono" style={{ fontSize: 12.5 }}>{sentAt ? `已發送 ${sentAt}` : "未發送"}</td>
      <td className="right">
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resendNotification(type, period), `r${type}`)}>{busy === `r${type}` ? "…" : "立即重發"}</button>{" "}
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resetNotification(type, period), `x${type}`)}>{busy === `x${type}` ? "…" : "重置"}</button>
      </td>
    </tr>
  );
  return (
    <Card title="推播狀態">
      {msg && <div style={{ color: "var(--teal)", padding: "8px 20px" }}>{msg}</div>}
      <table>
        <thead><tr><th>通知</th><th>狀態</th><th></th></tr></thead>
        <tbody>
          <Row label="開繳通知" type="billing_opened" sentAt={data?.billing_opened?.sent_at} />
          <Row label="逾期催繳" type="overdue" sentAt={data?.overdue?.sent_at} />
        </tbody>
      </table>
    </Card>
  );
}
```

Add `useState` to the React import at the top of Dashboard.tsx (it already imports `useState`).

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/admin && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/Dashboard.tsx
git commit -m "feat(admin): dashboard push-status panel with resend/reset"
```

---

### Task 11: Full suite, deploy, smoke

**Files:** none (integration/ops)

- [ ] **Step 1: Full worker suite + typecheck + admin build**

Run: `cd packages/worker && pnpm test && pnpm typecheck` then `cd ../admin && pnpm build`
Expected: all green.

- [ ] **Step 2: Deploy worker + admin Pages** (no new slash command, so no re-register)

Run: `cd packages/worker && export CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' .dev.vars | tr -d '"') && pnpm run deploy`
Then `cd ../admin && pnpm build && export CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' ../worker/.dev.vars | tr -d '"') && wrangler pages deploy dist --project-name=chippot-admin --branch=main --commit-dirty=true`
Expected: worker "Uploaded chippot" (route-reassert error non-fatal); admin Pages deployed.

- [ ] **Step 3: Live smoke (manual)**

1. Settings → edit the 逾期催繳文字 → save. Dashboard → 推播狀態 → 立即重發 逾期 → a single batched催繳 appears in the channel using your text, tagging all unpaid people once.
2. Dashboard → 開繳通知 → 立即重發 → re-posts the 開繳通知 (even if already sent). → 重置 → 立即重發 again works.
3. Payments list → click ✅ 驗證 on a paid row → it flips to verified without opening the modal; the verified channel = the declared one.
4. Settings → 還原 templates by editing back (or leave); confirm default behavior unchanged when templates are the defaults.

- [ ] **Step 4: Merge to main + record state**

```bash
git checkout main && git merge --ff-only admin-enhancements
```
Append a note to `docs/deploy-state.md` (templates + push-status panel + batched overdue live); commit.

---

## Self-Review (plan vs spec)

**Spec coverage:**
- F1 custom text (3 templates + placeholders) → Tasks 1, 2, 3, 4 (billing/overdue render), 5 (initiate), 7 (persistent message), 8 (Settings UI).
- Overdue batched per-period + dedup per (ws,period) → Tasks 3 (type), 4 (sendOverdueForPeriod + cron).
- F2 quick-verify → Task 9.
- F3 status + resend(force) + reset → Tasks 6 (API), 10 (UI). billing resend via initiateBillingOpened force (Task 5), overdue resend via sendOverdueForPeriod force (Task 4).
- discordPaymentMessage template → Task 7.

**Placeholder scan:** none — every step has full code.

**Type consistency:** `OverduePerson` (user_id/discord_id/user_name/lines/total), `Notifier.sendOverdue(env,channelId,period,people,template)` + `sendBillingOpened(...,template)`, `renderTemplate(template, vars)`, `sendOverdueForPeriod(env,ws,period,notifier,{force,now})`, `initiateBillingOpened(...,notifier,opts?{force})`, settings `overdue_template`/`billing_opened_template`/`payment_message_template`, endpoints `/admin/notifications`/`/resend`/`/reset` — used identically across tasks.

**Known mid-phase red:** Task 3 changes the Notifier interface → typecheck red on scheduled.ts/billing.ts until Tasks 4–5; each task's own tests pass in isolation; full typecheck green at Task 5.
