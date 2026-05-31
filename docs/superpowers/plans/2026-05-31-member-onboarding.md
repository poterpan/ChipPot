# 成員上線（Discord 自助綁定 + CSV 匯入器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let imported members self-bind their Discord account to their roster record (button → auto-continue to pay; `/綁定` → bind only), and add a reusable admin CSV importer that upserts users + subscriptions.

**Architecture:** A core `bindDiscordId` does an atomic guarded UPDATE so a Discord account binds to exactly one unbound member and a name can't be double-claimed. A core `importRoster` parses the Google-Forms CSV and upserts users (by email, keeping any existing `discord_id`) + subscriptions (reusing `ensureFirstPayment`). The Discord handler grows a bind string-select whose `custom_id` carries the entry origin (`pay`/`cmd`); the admin SPA gets an import page. The one-time 9-person load was already done via SQL.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, Vitest + `@cloudflare/vitest-pool-workers`, Discord interactions, Vite + React admin SPA.

**Source spec:** `docs/superpowers/specs/2026-05-31-member-onboarding-design.md`

---

## File Structure

**Worker — new files**
- `packages/worker/src/core/import.ts` — `parseRosterCsv` + `importRoster` + types.
- `packages/worker/test/core/binding.test.ts` — `listUnboundUsers` + `bindDiscordId`.
- `packages/worker/test/core/import.test.ts` — CSV parse + roster upsert.
- `packages/worker/test/adapters/discord-bind.test.ts` — button→bind→pay, `/綁定`, guards.

**Worker — modified files**
- `src/core/db.ts` — add `listUnboundUsers`, `bindDiscordId` (binding lives with the other user queries).
- `src/adapters/discord/commands.ts` — `BIND_SELECT_PREFIX`, `bindSelectRow`, `BIND_COMMAND`.
- `src/adapters/discord/handler.ts` — `resolveWs` split, `buildPayPrompt`, button unbound→bind, `/綁定`, `handleBindSelect`, component dispatch, `/繳費` unbound hint.
- `src/routes/admin.ts` — `POST /admin/members/import`; `updateUser` discord_id conflict 400.
- `packages/worker/scripts/register-commands.mjs` — add `/綁定`.

**Admin SPA — modified files**
- `packages/admin/src/api.ts` — `importMembers` (multipart).
- `packages/admin/src/views/Settings.tsx` — 匯入名單 section.

---

# PHASE 1 — Core domain

### Task 1: `listUnboundUsers` (core/db.ts)

**Files:**
- Modify: `packages/worker/src/core/db.ts`
- Test: `packages/worker/test/core/binding.test.ts` (create)

- [ ] **Step 1: Write the failing test** (`binding.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listUnboundUsers } from "../../src/core/db";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9027;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(WS, WS, "Bound", "d-9027", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(90271, WS, "Unbound A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(90272, WS, "Unbound B", TS, TS),
  ]);
});

describe("listUnboundUsers", () => {
  it("returns only users with NULL discord_id, ordered by id", async () => {
    const u = await listUnboundUsers(env.DB, WS);
    expect(u.map((x) => x.display_name)).toEqual(["Unbound A", "Unbound B"]);
    expect(u[0]).toMatchObject({ id: 90271 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/binding`
Expected: FAIL — `listUnboundUsers` not exported.

- [ ] **Step 3: Implement in `src/core/db.ts`** (append at end)

```ts
export interface UnboundUser {
  id: number;
  display_name: string;
}

/** Users in a workspace that have not yet linked a Discord account (for the self-bind select). */
export async function listUnboundUsers(
  db: D1Database,
  workspaceId: number
): Promise<UnboundUser[]> {
  const { results } = await db
    .prepare("SELECT id, display_name FROM users WHERE workspace_id = ? AND discord_id IS NULL ORDER BY id")
    .bind(workspaceId)
    .all<UnboundUser>();
  return results;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/binding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/db.ts packages/worker/test/core/binding.test.ts
git commit -m "feat(db): listUnboundUsers"
```

---

### Task 2: `bindDiscordId` (core/db.ts)

**Files:**
- Modify: `packages/worker/src/core/db.ts`
- Test: `packages/worker/test/core/binding.test.ts`

- [ ] **Step 1: Add the failing tests** (append to `binding.test.ts`)

```ts
import { bindDiscordId } from "../../src/core/db";

describe("bindDiscordId", () => {
  it("binds an unbound user and returns ok + name", async () => {
    const r = await bindDiscordId(env, WS, 90271, "newdisc-1");
    expect(r).toEqual({ status: "ok", boundName: "Unbound A" });
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(90271).first<{ discord_id: string }>();
    expect(u?.discord_id).toBe("newdisc-1");
  });

  it("rejects when the Discord account is already bound to someone else", async () => {
    // "newdisc-1" is now on user 90271; trying to bind it to 90272 must fail.
    const r = await bindDiscordId(env, WS, 90272, "newdisc-1");
    expect(r).toEqual({ status: "already_bound_other", boundName: "Unbound A" });
  });

  it("rejects binding a name that was already taken (target already bound)", async () => {
    // 90271 already has a discord_id; binding it again with a fresh account is name_taken.
    const r = await bindDiscordId(env, WS, 90271, "fresh-disc");
    expect(r.status).toBe("name_taken");
  });

  it("returns not_found for a user outside the workspace", async () => {
    const r = await bindDiscordId(env, WS, 999999, "x-disc");
    expect(r.status).toBe("not_found");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/binding`
Expected: FAIL — `bindDiscordId` not exported.

- [ ] **Step 3: Implement in `src/core/db.ts`** (append)

```ts
import { nowUtcIso } from "./time";
import type { Env } from "../env";

export interface BindResult {
  status: "ok" | "already_bound_other" | "name_taken" | "not_found";
  boundName?: string;
}

/**
 * Atomically link a Discord account to an unbound member. The guarded UPDATE only applies
 * when the target is still unbound AND this Discord account isn't already on someone, so two
 * people can't claim the same name and one account can't bind to two names.
 */
export async function bindDiscordId(
  env: Env,
  workspaceId: number,
  userId: number,
  discordId: string
): Promise<BindResult> {
  const now = nowUtcIso();
  const res = await env.DB
    .prepare(
      `UPDATE users SET discord_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND discord_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ? AND discord_id = ?)`
    )
    .bind(discordId, now, userId, workspaceId, workspaceId, discordId)
    .run();

  if ((res.meta.changes ?? 0) === 1) {
    const u = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(userId).first<{ display_name: string }>();
    return { status: "ok", boundName: u?.display_name };
  }

  // Didn't apply — diagnose precisely.
  const other = await env.DB
    .prepare("SELECT display_name FROM users WHERE workspace_id = ? AND discord_id = ?")
    .bind(workspaceId, discordId)
    .first<{ display_name: string }>();
  if (other) return { status: "already_bound_other", boundName: other.display_name };

  const target = await env.DB
    .prepare("SELECT discord_id FROM users WHERE id = ? AND workspace_id = ?")
    .bind(userId, workspaceId)
    .first<{ discord_id: string | null }>();
  if (!target) return { status: "not_found" };
  if (target.discord_id !== null) return { status: "name_taken" };
  return { status: "not_found" };
}
```

> NOTE: `core/db.ts` currently has no imports (it relies on the ambient `D1Database`). Add the two `import` lines at the **top** of the file, not mid-file.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/binding`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/db.ts packages/worker/test/core/binding.test.ts
git commit -m "feat(db): bindDiscordId — atomic guarded Discord-account linking"
```

---

### Task 3: `parseRosterCsv` (core/import.ts)

**Files:**
- Create: `packages/worker/src/core/import.ts`
- Test: `packages/worker/test/core/import.test.ts` (create)

- [ ] **Step 1: Write the failing test** (`import.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { parseRosterCsv } from "../../src/core/import";

const CSV = `姓名,帳號,ChatGPT,Claude Standard,Claude Premium
潘柏嘉,poter.pan@x.tw,TRUE,FALSE,TRUE
柯艾妤,aiiiii@x.tw,FALSE,TRUE,FALSE
,blank@x.tw,TRUE,FALSE,FALSE

陳怡晶,chingching@x.tw,true,false,false`;

describe("parseRosterCsv", () => {
  it("extracts name, email, and TRUE plan columns (case-insensitive); skips blank lines", () => {
    const rows = parseRosterCsv(CSV);
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ name: "潘柏嘉", email: "poter.pan@x.tw", plans: ["ChatGPT", "Claude Premium"] });
    expect(rows[1]).toEqual({ name: "柯艾妤", email: "aiiiii@x.tw", plans: ["Claude Standard"] });
    expect(rows[2]).toEqual({ name: "", email: "blank@x.tw", plans: ["ChatGPT"] });
    expect(rows[3]).toEqual({ name: "陳怡晶", email: "chingching@x.tw", plans: [] });
  });

  it("returns [] for empty or header-only input", () => {
    expect(parseRosterCsv("")).toEqual([]);
    expect(parseRosterCsv("姓名,帳號,ChatGPT")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/import`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/import.ts`**

```ts
import type { Env } from "../env";
import { nowUtcIso } from "./time";
import { ensureFirstPayment } from "./billing";

export interface RosterRow {
  name: string;
  email: string;
  plans: string[];
}

/** Split a simple CSV line on commas (the club roster has no quoted/embedded commas). */
function splitCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Parse a Google-Forms roster CSV: header `姓名,帳號,<plan name…>`. A row subscribes to a plan
 * column when its cell is "TRUE" (case-insensitive). Blank lines are skipped.
 */
export function parseRosterCsv(text: string): RosterRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const planCols = splitCsvLine(lines[0]).slice(2);
  const rows: RosterRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const plans: string[] = [];
    planCols.forEach((col, idx) => {
      if ((cells[idx + 2] ?? "").toUpperCase() === "TRUE") plans.push(col);
    });
    rows.push({ name: cells[0] ?? "", email: cells[1] ?? "", plans });
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/import.ts packages/worker/test/core/import.test.ts
git commit -m "feat(import): parseRosterCsv"
```

---

### Task 4: `importRoster` (core/import.ts)

**Files:**
- Modify: `packages/worker/src/core/import.ts`
- Test: `packages/worker/test/core/import.test.ts`

- [ ] **Step 1: Add the failing test** (append to `import.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { importRoster } from "../../src/core/import";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9028;
const PLAN_GPT = 9028, PLAN_STD = 90281;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_GPT, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_STD, WS, "Claude Standard", "anthropic", 251, TS, TS),
    // a pre-existing member (by email) who already has a bound discord_id + one sub
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "Old Name", "amy@x.tw", "disc-amy", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, WS, PLAN_GPT, "2026-06-01", 5, TS, TS),
  ]);
});

describe("importRoster", () => {
  it("upserts by email (keeps discord_id), creates subs + first payments, reports unmatched plans", async () => {
    const rows = [
      { name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"] }, // existing: keep disc, skip GPT, add STD
      { name: "Ben", email: "ben@x.tw", plans: ["Claude Standard", "Gemini"] },        // new user, STD sub, Gemini unmatched
      { name: "NoEmail", email: "", plans: ["ChatGPT"] },                              // skipped row
    ];
    const s = await importRoster(env, WS, rows, { startDate: "2026-06-01" });
    expect(s).toMatchObject({ usersCreated: 1, usersUpdated: 1, subsCreated: 2, subsSkipped: 1, rowsSkipped: 1 });
    expect(s.unmatchedPlans).toEqual(["Gemini"]);

    // existing member kept discord_id, name updated
    const amy = await env.DB.prepare("SELECT display_name, discord_id FROM users WHERE email='amy@x.tw'").first<{ display_name: string; discord_id: string }>();
    expect(amy).toMatchObject({ display_name: "Amy New", discord_id: "disc-amy" });

    // Ben got a STD sub + a 2026-06 pending payment
    const ben = await env.DB.prepare("SELECT id FROM users WHERE email='ben@x.tw'").first<{ id: number }>();
    const pay = await env.DB.prepare(
      `SELECT p.status FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.user_id=? AND p.period='2026-06'`
    ).bind(ben!.id).first<{ status: string }>();
    expect(pay?.status).toBe("pending");
  });

  it("is idempotent on a re-run (no new users/subs)", async () => {
    const rows = [{ name: "Amy New", email: "amy@x.tw", plans: ["ChatGPT", "Claude Standard"] }];
    const s = await importRoster(env, WS, rows, { startDate: "2026-06-01" });
    expect(s).toMatchObject({ usersCreated: 0, usersUpdated: 1, subsCreated: 0, subsSkipped: 2 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test core/import`
Expected: FAIL — `importRoster` not exported.

- [ ] **Step 3: Implement in `src/core/import.ts`** (append)

```ts
export interface ImportOptions {
  startDate: string; // YYYY-MM-DD; subscriptions' start (drives the first payment's period)
}

export interface ImportSummary {
  usersCreated: number;
  usersUpdated: number;
  subsCreated: number;
  subsSkipped: number;
  rowsSkipped: number;
  unmatchedPlans: string[];
}

/**
 * Upsert a roster: match users by email (update name, keep discord_id; else insert with
 * discord_id NULL), then for each TRUE plan ensure an active subscription (reusing
 * ensureFirstPayment to create the start-month pending payment). Idempotent.
 */
export async function importRoster(
  env: Env,
  workspaceId: number,
  rows: RosterRow[],
  opts: ImportOptions
): Promise<ImportSummary> {
  const now = nowUtcIso();
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(workspaceId).first<{ billing_day: number }>();
  const billingDay = wsRow?.billing_day ?? 5;
  const plans = await env.DB.prepare("SELECT id, name FROM plans WHERE workspace_id = ? AND active = 1").bind(workspaceId).all<{ id: number; name: string }>();
  const planByName = new Map(plans.results.map((p) => [p.name, p.id]));

  const summary: ImportSummary = { usersCreated: 0, usersUpdated: 0, subsCreated: 0, subsSkipped: 0, rowsSkipped: 0, unmatchedPlans: [] };
  const unmatched = new Set<string>();

  for (const row of rows) {
    if (!row.email) { summary.rowsSkipped++; continue; }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE workspace_id = ? AND email = ?").bind(workspaceId, row.email).first<{ id: number }>();
    let userId: number;
    if (existing) {
      await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").bind(row.name, now, existing.id).run();
      userId = existing.id;
      summary.usersUpdated++;
    } else {
      const res = await env.DB.prepare("INSERT INTO users (workspace_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(workspaceId, row.name, row.email, now, now).run();
      userId = res.meta.last_row_id as number;
      summary.usersCreated++;
    }

    for (const planName of row.plans) {
      const planId = planByName.get(planName);
      if (!planId) { unmatched.add(planName); continue; }
      const sub = await env.DB.prepare("SELECT id FROM subscriptions WHERE workspace_id = ? AND user_id = ? AND plan_id = ? AND status = 'active'").bind(workspaceId, userId, planId).first<{ id: number }>();
      if (sub) { summary.subsSkipped++; continue; }
      const ins = await env.DB.prepare(
        "INSERT INTO subscriptions (workspace_id, user_id, plan_id, start_date, billing_day, custom_cycle, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)"
      ).bind(workspaceId, userId, planId, opts.startDate, billingDay, now, now).run();
      await ensureFirstPayment(env.DB, ins.meta.last_row_id as number);
      summary.subsCreated++;
    }
  }

  summary.unmatchedPlans = [...unmatched];
  return summary;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test core/import`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/import.ts packages/worker/test/core/import.test.ts
git commit -m "feat(import): importRoster — upsert users/subs by email, reuse ensureFirstPayment"
```

---

### ✅ Phase 1 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test core` — all green.
- [ ] **Codex review** (foreground), forward:
  > Review ChipPot member-onboarding Phase 1 core. Files: packages/worker/src/core/db.ts (bindDiscordId — verify the guarded UPDATE makes Discord-account linking atomic: a target binds only while NULL, an account can't bind to two members, and the status diagnosis after a 0-row update is correct), packages/worker/src/core/import.ts (importRoster — verify email upsert keeps existing discord_id, active-sub dedup is correct, ensureFirstPayment reuse creates the right start-month payment, idempotent re-run). Flag any race, double-bind, or upsert bug.
- [ ] Address findings one at a time, test each.

---

# PHASE 2 — Discord adapter

### Task 5: Bind constants + components + command (commands.ts)

**Files:**
- Modify: `packages/worker/src/adapters/discord/commands.ts`

- [ ] **Step 1: Add to `src/adapters/discord/commands.ts`**

After the `INITIATE_MODAL_PREFIX` line, add:

```ts
// The self-bind string-select (action:workspace:origin). origin ∈ {pay, cmd}.
export const BIND_SELECT_PREFIX = "chippot:bind";
```

After `channelSelectRow`, add:

```ts
/** String-select of unbound members for self-binding. origin drives the post-bind action. */
export function bindSelectRow(
  workspaceId: number,
  origin: "pay" | "cmd",
  users: { id: number; display_name: string }[]
) {
  return {
    type: CT_ACTION_ROW,
    components: [{
      type: CT_STRING_SELECT,
      custom_id: `${BIND_SELECT_PREFIX}:${workspaceId}:${origin}`,
      placeholder: "選擇你的名字",
      min_values: 1,
      max_values: 1,
      options: users.slice(0, 25).map((u) => ({ label: u.display_name, value: String(u.id) })),
    }],
  };
}
```

After `INITIATE_COMMAND`, add:

```ts
/** `/綁定` command registration payload. */
export const BIND_COMMAND = {
  name: "綁定",
  type: 1,
  description: "把你的 Discord 帳號綁定到名單上的成員",
};
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (no new errors from commands.ts; handler.ts unchanged so far).

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/adapters/discord/commands.ts
git commit -m "feat(discord): bind select component + /綁定 command"
```

---

### Task 6: Handler — self-bind flow + buildPayPrompt + /繳費 unbound hint

**Files:**
- Modify: `packages/worker/src/adapters/discord/handler.ts`
- Test: `packages/worker/test/adapters/discord-bind.test.ts` (create)

- [ ] **Step 1: Write the failing test** (`discord-bind.test.ts`)

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { taipeiPeriod } from "../../src/core/time";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9029;
const GUILD = "guild-9029";
const TAG = 9029;
const PLAN = 9029;
const U_UNBOUND = 90291; // unbound member to claim
const PERIOD = taipeiPeriod();

const tasks: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_UNBOUND, WS, "小明", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, WS, U_UNBOUND, PLAN, "2026-05-01", 5, TS, TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "linepay", 1, TS),
  ]);
});

describe("self-bind flow", () => {
  it("unbound member tapping 繳費 gets the bind select (origin=pay)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    const sel = body.data.components[0].components[0];
    expect(sel.custom_id).toBe(`chippot:bind:${WS}:pay`);
    expect(sel.options.map((o: any) => o.label)).toContain("小明");
  });

  it("bind via button (origin=pay) binds AND continues to the pay prompt (channel select)", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { custom_id: `chippot:bind:${WS}:pay`, component_type: 3, values: [String(U_UNBOUND)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7); // UPDATE_MESSAGE
    expect(body.data.content).toContain("已綁定為 小明");
    expect(body.data.components[0].components[0].custom_id).toBe(`chippot:paysel:${WS}:${PERIOD}`);
    const u = await env.DB.prepare("SELECT discord_id FROM users WHERE id=?").bind(U_UNBOUND).first<{ discord_id: string }>();
    expect(u?.discord_id).toBe("disc-new");
  });

  it("a second account claiming the same (now bound) name is rejected", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, ...member("disc-other"),
      data: { custom_id: `chippot:bind:${WS}:cmd`, component_type: 3, values: [String(U_UNBOUND)] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(7);
    expect(body.data.content).toMatch(/綁定|失效/);
  });

  it("/綁定 lists unbound members; an already-bound caller is told so", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member("disc-new"),
      data: { name: "綁定" },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.data.content).toContain("已綁定");
  });

  it("/繳費 from an unbound account returns a bind hint (not a settle)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit | undefined) => {
      if (typeof init?.body === "string") captured.push(JSON.parse(init.body).content);
      return new Response("{}", { status: 200 });
    }));
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "tok", guild_id: GUILD, ...member("totally-unbound"),
      data: { name: "繳費", options: [{ name: "備註", value: "hi" }] },
    };
    await routeInteraction(i, env, CTX);
    await Promise.all(tasks.splice(0));
    vi.unstubAllGlobals();
    expect(captured.some((c) => c.includes("綁定"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test discord-bind`
Expected: FAIL — bind not handled; button still says "不是登記的成員".

- [ ] **Step 3: Edit `src/adapters/discord/handler.ts`**

**(3a) Imports.** Replace the db import line and the commands import to add the new symbols:

```ts
import {
  getWorkspaceIdByGuild, getUserByDiscordId, listActiveSubscriptions,
  listActiveChannelTags, listSettleablePayments, listUnboundUsers, bindDiscordId,
} from "../../core/db";
import { writeAudit } from "../../core/audit";
```

and add to the `./commands` import list: `IT_COMMAND` is already there; add `BIND_SELECT_PREFIX, bindSelectRow`.

**(3b) Split `resolveMember` into `resolveWs` + `resolveMember`.** Replace the existing `resolveMember` with:

```ts
/** Resolve guild→workspace + the caller's Discord id (no membership requirement). */
async function resolveWs(
  i: DiscordInteraction, env: Env
): Promise<{ ws: number; discordId: string } | Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  const did = discordUserId(i);
  if (!did) return ephemeral("無法辨識你的 Discord 帳號。");
  return { ws, discordId: did };
}

/** Resolve a registered (bound) member, or an ephemeral error Response. */
async function resolveMember(
  i: DiscordInteraction, env: Env
): Promise<{ ws: number; userId: number } | Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const user = await getUserByDiscordId(env.DB, r.ws, r.discordId);
  if (!user) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");
  return { ws: r.ws, userId: user.id };
}
```

**(3c) Extract `buildPayPrompt` and rewrite `handlePayButton`.** Replace the whole `handlePayButton` function with:

```ts
/** The pay prompt shown after the button (or after a button-originated bind). */
async function buildPayPrompt(
  env: Env, ws: number, userId: number
): Promise<{ content: string; components: unknown[] }> {
  const subs = await listActiveSubscriptions(env.DB, ws, userId);
  if (subs.length === 0) return { content: "你目前沒有有效訂閱。", components: [] };
  const period = taipeiPeriod();
  for (const s of subs) await ensurePeriodPayment(env.DB, s.id, period);
  const settleable = await listSettleablePayments(env.DB, ws, userId, period);
  if (settleable.length === 0) return { content: "✅ 你本期已登記繳費，無需重複操作。", components: [] };
  const tags = await listActiveChannelTags(env.DB, ws);
  if (tags.length === 0) return { content: "管理員尚未設定繳費渠道，請改用 `/繳費` 指令（可附截圖或備註）。", components: [] };
  const total = settleable.reduce((s, r) => s + r.amount, 0);
  const lines = settleable.map((r) => `・${r.plan_name}：NT$${r.amount.toLocaleString()}`).join("\n");
  return {
    content: `本期（${period}）應繳：\n${lines}\n**合計 NT$${total.toLocaleString()}**\n\n請選擇繳費渠道送出。想附截圖／備註？改用 \`/繳費\`。`,
    components: [channelSelectRow(ws, period, tags)],
  };
}

async function handlePayButton(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) {
    const unbound = await listUnboundUsers(env.DB, ws);
    if (unbound.length === 0) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");
    return json({
      type: RT_MESSAGE,
      data: {
        flags: FLAG_EPHEMERAL,
        content: "請選擇你的名字以綁定 Discord 帳號（只列出尚未綁定的成員）。",
        components: [bindSelectRow(ws, "pay", unbound)],
      },
    });
  }
  const prompt = await buildPayPrompt(env, ws, user.id);
  return json({ type: RT_MESSAGE, data: { flags: FLAG_EPHEMERAL, content: prompt.content, components: prompt.components } });
}
```

**(3d) Add `/綁定` command routing + `handleBindCommand` + `handleBindSelect`.** In `handleCommand`, add a branch before the final return:

```ts
  if (i.data?.name === "綁定") return handleBindCommand(i, env);
```

In `handleComponent`, add the bind-select branch **before** the pay branches:

```ts
  if (cid.startsWith(BIND_SELECT_PREFIX)) return handleBindSelect(i, env);
```

Add these functions (near the other component handlers):

```ts
async function handleBindCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (existing) return ephemeral(`你已綁定為 ${existing.display_name}。`);
  const unbound = await listUnboundUsers(env.DB, ws);
  if (unbound.length === 0) return ephemeral("目前沒有可綁定的成員，請聯絡管理員。");
  return json({
    type: RT_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: "請選擇你的名字以綁定 Discord 帳號（只列出尚未綁定的成員）。",
      components: [bindSelectRow(ws, "cmd", unbound)],
    },
  });
}

async function handleBindSelect(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const updateErr = (content: string) =>
    json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });

  const parts = (i.data?.custom_id ?? "").split(":"); // chippot:bind:<ws>:<origin>
  const origin = parts[3];
  if (Number(parts[2]) !== ws || (origin !== "pay" && origin !== "cmd")) {
    return updateErr("這個綁定選單已失效，請重新操作。");
  }
  const targetUserId = Number(i.data?.values?.[0]);
  if (!Number.isInteger(targetUserId)) return updateErr("選擇無效，請重新操作。");

  const result = await bindDiscordId(env, ws, targetUserId, discordId);
  if (result.status === "already_bound_other") return updateErr(`你的 Discord 帳號已綁定為 ${result.boundName}。`);
  if (result.status === "name_taken") return updateErr("這個名字剛被綁定了，請重新操作。");
  if (result.status === "not_found") return updateErr("找不到該成員，請重新操作。");

  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordId}`, action: "member.bind",
    entityType: "user", entityId: targetUserId, after: { discord_id: discordId },
  });

  if (origin === "pay") {
    const prompt = await buildPayPrompt(env, ws, targetUserId);
    return json({
      type: RT_UPDATE_MESSAGE,
      data: { content: `✅ 已綁定為 ${result.boundName}。\n${prompt.content}`, components: prompt.components },
    });
  }
  return updateErr(`✅ 已綁定為 ${result.boundName}。之後點「繳費」按鈕或用 \`/繳費\` 即可登記繳費。`);
}
```

**(3e) `/繳費` unbound hint.** In `computePayResult`, replace the opening `resolveMember` block:

```ts
  const r = await resolveWs(i, env);
  if (r instanceof Response) return ((await r.json()) as any).data.content;
  const { ws, discordId } = r;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) return "你還沒綁定 Discord 帳號，請點「繳費」按鈕或用 `/綁定` 完成綁定後再試。";
  const userId = user.id;
```

Then replace the later uses of `ws`/`userId` (they already match these names) — the rest of `computePayResult` continues unchanged using `ws` and `userId`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test discord-bind discord-pay discord-handler && pnpm typecheck`
Expected: PASS for all three adapter suites; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-bind.test.ts
git commit -m "feat(discord): self-bind select (button→pay continuation / cmd→bind-only), /繳費 unbound hint"
```

---

### Task 7: Register `/綁定` in the registration script

**Files:**
- Modify: `packages/worker/scripts/register-commands.mjs`

- [ ] **Step 1: Add `/綁定` to the `commands` array** in `scripts/register-commands.mjs` (after the 發起繳費 entry):

```js
  {
    name: "綁定", type: 1,
    description: "把你的 Discord 帳號綁定到名單上的成員",
  },
```

- [ ] **Step 2: Syntax-check**

Run: `node -c packages/worker/scripts/register-commands.mjs`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add packages/worker/scripts/register-commands.mjs
git commit -m "chore(discord): register /綁定 command"
```

---

### ✅ Phase 2 checkpoint — Codex review

- [ ] **Run:** `cd packages/worker && pnpm test adapters` — all green.
- [ ] **Codex review** (foreground):
  > Review ChipPot member-onboarding Phase 2 Discord adapter. Files: packages/worker/src/adapters/discord/handler.ts, packages/worker/src/adapters/discord/commands.ts. Verify: handleComponent dispatches chippot:bind before chippot:pay/paysel (prefix-collision safe); the bind select custom_id origin (pay/cmd) is strictly parsed and drives the right post-bind action (button→buildPayPrompt continuation returning a channel-select, cmd→confirm only); bindDiscordId result statuses map to correct user messages; an unbound /繳費 returns a hint not a settle; no way for a non-member to settle. Flag any prefix collision, custom_id parse, or auth bug.
- [ ] Address findings, test each.

---

# PHASE 3 — Admin import + integration

### Task 8: `POST /admin/members/import` (admin route)

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: Add the failing test** (append a `describe` to `admin.test.ts`)

```ts
describe("admin members import", () => {
  it("imports a CSV (JSON body) and returns a summary", async () => {
    const csv = "姓名,帳號,ChatGPT,Claude Standard,Claude Premium\nNewMember,newmember@x.tw,TRUE,FALSE,FALSE";
    const res = await call("POST", "/admin/members/import", { csv, start_date: "2027-11-01" });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.summary).toMatchObject({ usersCreated: 1, subsCreated: 1 });
    const u = await env.DB.prepare("SELECT id FROM users WHERE email='newmember@x.tw'").first<{ id: number }>();
    expect(u).not.toBeNull();
  });

  it("rejects a missing csv and a bad start_date", async () => {
    expect((await call("POST", "/admin/members/import", {}))!.status).toBe(400);
    expect((await call("POST", "/admin/members/import", { csv: "姓名,帳號\nA,a@x.tw", start_date: "bad" }))!.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement in `src/routes/admin.ts`**

Add imports:

```ts
import { parseRosterCsv, importRoster } from "../core/import";
```

Add the handler (near `billingInitiate`):

```ts
async function membersImport(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  let csv: string | null = null;
  let startDate: string | undefined;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    if (f && typeof f !== "string") csv = await (f as Blob).text();
    const sd = form.get("start_date");
    if (typeof sd === "string" && sd) startDate = sd;
  } else {
    const b = await readJson<{ csv?: string; start_date?: string }>(req);
    csv = b?.csv ?? null;
    startDate = b?.start_date;
  }
  if (!csv) return errorResponse(400, "csv is required");
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return errorResponse(400, "start_date must be YYYY-MM-DD");
  const start = startDate ?? `${taipeiPeriod()}-01`;
  const summary = await importRoster(env, ws, parseRosterCsv(csv), { startDate: start });
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "roster.import", entityType: "workspace", entityId: ws, after: summary });
  return json({ ok: true, summary });
}
```

Register it in `buildAdminRouter()` (after `billingInitiate`):

```ts
    .post("/admin/members/import", membersImport)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin-api): POST /admin/members/import"
```

---

### Task 9: `updateUser` discord_id conflict → 400

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: Add the failing test** (append to the `admin members import` describe or a nearby one)

```ts
it("PATCH /admin/users rejects a discord_id already bound to another member", async () => {
  const a = await call("POST", "/admin/users", { display_name: "Conflicter", discord_id: "dup-disc" });
  expect(a!.status).toBe(201);
  const b = await call("POST", "/admin/users", { display_name: "Other" });
  const otherId = ((await b!.json()) as any).id as number;
  const res = await call("PATCH", `/admin/users/${otherId}`, { discord_id: "dup-disc" });
  expect(res!.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: FAIL — currently throws/500 (UNIQUE violation) instead of 400.

- [ ] **Step 3: Implement in `src/routes/admin.ts`** — in `updateUser`, after loading `before` and parsing `b`, before the UPDATE:

```ts
  if (b.discord_id) {
    const clash = await env.DB.prepare("SELECT id FROM users WHERE workspace_id = ? AND discord_id = ? AND id <> ?")
      .bind(wsId(ctx), b.discord_id, id).first<{ id: number }>();
    if (clash) return errorResponse(400, "此 Discord ID 已綁定其他成員");
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/worker && pnpm test routes/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin-api): reject duplicate discord_id on user update with 400"
```

---

### Task 10: Admin SPA — 匯入名單 section

**Files:**
- Modify: `packages/admin/src/api.ts`, `packages/admin/src/views/Settings.tsx`

- [ ] **Step 1: Add the API method** to `packages/admin/src/api.ts` (inside the `api` object):

```ts
  importMembers: async (file: File, startDate?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (startDate) fd.append("start_date", startDate);
    const r = await fetch(`${BASE}/members/import`, { method: "POST", body: fd });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(data?.error ?? `錯誤 ${r.status}`);
    return data as { summary: { usersCreated: number; usersUpdated: number; subsCreated: number; subsSkipped: number; rowsSkipped: number; unmatchedPlans: string[] } };
  },
```

- [ ] **Step 2: Add the import section** to `Settings.tsx`. Render `<ImportRoster />` after `<InitiateBilling />`, and add the component:

```tsx
function ImportRoster() {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (!file) { setErr("請選擇 CSV 檔"); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.importMembers(file, start || undefined);
      const s = r.summary;
      setMsg(`✓ 建立 ${s.usersCreated} 人 / 更新 ${s.usersUpdated} 人 / 新增 ${s.subsCreated} 訂閱 / 跳過 ${s.subsSkipped} 訂閱 / 略過 ${s.rowsSkipped} 列` +
        (s.unmatchedPlans.length ? ` · 對不到的方案：${s.unmatchedPlans.join(", ")}` : ""));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
      <div className="field__label">匯入名單（CSV）</div>
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 10px" }}>欄位需為「姓名, 帳號, 方案名…」；方案名須與系統方案一致。空白＝起算當月。</p>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
      <div style={{ marginTop: 10 }}>
        <Field label="起算月份第一天（選填，YYYY-MM-DD）"><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01" disabled={busy} /></Field>
      </div>
      <button className="btn btn--primary" onClick={run} disabled={busy}>匯入</button>
    </>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/admin && pnpm typecheck && pnpm build`
Expected: PASS; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/Settings.tsx
git commit -m "feat(admin): 匯入名單 CSV upload + summary"
```

---

### Task 11: Full suite, deploy, register, smoke

**Files:** none (integration/ops)

- [ ] **Step 1: Full worker suite + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: all green; typecheck clean.

- [ ] **Step 2: Deploy worker**

Run: `cd packages/worker && export CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' .dev.vars | tr -d '"') && pnpm run deploy`
Expected: "Uploaded chippot" (the zone-route re-assert error is non-fatal, as documented in deploy-state.md).

- [ ] **Step 3: Deploy admin Pages** (the only SPA that changed)

Run: `cd packages/admin && pnpm build && export CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' ../worker/.dev.vars | tr -d '"') && wrangler pages deploy dist --project-name=chippot-admin --branch=main --commit-dirty=true`
Expected: Deployment complete.

- [ ] **Step 4: Register `/綁定`**

Run: `cd packages/worker && DISCORD_APPLICATION_ID=1510355256498978917 DISCORD_GUILD_ID=1305872150015639623 node scripts/register-commands.mjs`
Expected: `200` with 繳費 + 發起繳費 + 綁定.

- [ ] **Step 5: Live smoke (manual, in Discord)**

1. As a member who isn't bound, tap 「繳費」 → should show the "選你的名字" dropdown listing the 9 imported members → pick yourself → it binds AND immediately shows your 2026-05 plans + total + channel select. Pick a channel → settles.
2. `/綁定` as the already-bound account → "你已綁定為 …".
3. `/綁定` as a second unbound account, pick a name already taken → rejected.
4. Admin → 成員: try setting a Discord ID that's already used → 400 message.
5. Admin → 設定 → 匯入名單: re-upload the same CSV → summary shows updated N / skipped subs (idempotent, no dupes).

- [ ] **Step 6: Merge to main + record state**

```bash
git checkout main && git merge --ff-only member-onboarding
```
Update `docs/deploy-state.md` with the `/綁定` registration + that binding is live; commit.

---

## Self-Review (plan vs spec)

**Spec coverage:**
- Discord self-bind (button auto-continue / cmd bind-only / `/繳費` hint) → Tasks 5, 6.
- bind select lists only unbound, origin in custom_id → Tasks 5, 6.
- atomic guarded bind + status messages → Task 2, used in Task 6.
- admin manual discord_id (B) conflict 400 → Task 9.
- reusable CSV importer (parse + upsert + ensureFirstPayment + summary) → Tasks 3, 4, 8.
- import UI in Settings → Task 10.
- register `/綁定` → Task 7 (script) + Task 11 step 4 (run).
- one-time 9-person load → already done via SQL (noted in spec; not a task).

**Placeholder scan:** none — every step has full code.

**Type consistency:** `bindDiscordId`/`BindResult` (status: ok|already_bound_other|name_taken|not_found, boundName), `listUnboundUsers`/`UnboundUser`, `parseRosterCsv`/`RosterRow`, `importRoster`/`ImportOptions`/`ImportSummary`, `BIND_SELECT_PREFIX`/`bindSelectRow(ws, origin, users)`/`BIND_COMMAND`, `buildPayPrompt(env, ws, userId)`, `resolveWs` — all used consistently across tasks.
