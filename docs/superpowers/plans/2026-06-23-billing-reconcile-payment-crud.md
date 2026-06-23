# 期別帳單對帳 ＋ 繳費紀錄 CRUD 補完 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓管理員能修正帳本錯誤：重新同步某期帳單到目前名單/現價、刪除單筆繳費、撤回誤驗證，並對同步新增的成員推繳費按鈕。

**Architecture:** 後端核心邏輯放 `core/`（純函式、可單測），路由薄層放 `routes/admin.ts`，Discord 訊息走既有 `Notifier`，前端在 `Dashboard`（同步）與 `Payments`（刪除/撤回）。沿用既有 helper（`wsId`/`actorOf`/`writeAudit`/`errorResponse`/`json`/`ensurePeriodPayment`/`applyTransition`）。

**Tech Stack:** TypeScript Cloudflare Workers + D1 + R2；Vitest 4 + `@cloudflare/vitest-pool-workers`（真 D1/R2）；React + Vite（admin SPA）。

## Global Constraints

- 測試一律走 `@cloudflare/vitest-pool-workers`（`import { env } from "cloudflare:test"`），每個 test FILE 用**獨立 id-space**（沿用既有慣例，如 `WS = 90xx`）。
- 所有 admin 路由經 Access 保護；handler 簽章 `(req: Request, env: Env, ctx: RouteCtx) => Promise<Response>`；用 `wsId(ctx)`、`actorOf(ctx)`、`errorResponse(status,msg)`、`json(data,opts?)`、`readJson<T>(req)`、`writeAudit(env.DB,{...})`、`PERIOD_RE`。
- R2 為選填：刪 R2 物件一律 `if (key && env.BUCKET) await env.BUCKET.delete(key).catch(()=>{})`。
- 命名避坑：既有 `core/reconcile.ts` 的 `reconcilePeriod` 與 `GET /admin/reconcile`（對帳**統計**）已存在；本功能用 `core/billing.ts` 的 **`reconcilePeriodBills`** + 路由 **`POST /admin/billing/:period/sync`** + api 方法 **`syncPeriodBills`**，勿混用。
- 繳費通知文案中性（非催繳語氣）；`allowed_mentions` 一律 `parse:[]` + 明確 `users`/`roles` 白名單。
- 每個 task 結束 commit；commit message 用 `feat:`/`fix:`/`test:` 前綴。
- 與使用者以**繁體中文（zh-TW）** 溝通。
- 階段邊界（Phase 1/2/3 結束）呼叫 **Codex** 做 review（既有自主建置慣例），review 意見處理完才進下一階段。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `packages/worker/src/core/payments.ts` | 改 | 狀態機加 `verified→pending`；新增 `unverifyPayment` |
| `packages/worker/src/core/billing.ts` | 改 | 新增 `reconcilePeriodBills` + 型別 `ReconcileLine`/`ReconcileDiff` |
| `packages/worker/src/core/notify.ts` | 改 | `Notifier` 介面加 `sendPaymentNudge` |
| `packages/worker/src/adapters/discord/notify.ts` | 改 | `sendPaymentNudge` Discord 實作 |
| `packages/worker/src/routes/admin.ts` | 改 | 加 `deletePayment`/`unverifyPaymentHandler`/`syncPeriodBills` 路由 + handler；`updateUser` COALESCE 修正 |
| `packages/admin/src/api.ts` | 改 | 加 `deletePayment`/`unverify`/`syncPeriodBills` |
| `packages/admin/src/views/Payments.tsx` | 改 | `PaymentDetail` 加「刪除此筆」「撤回驗證」 |
| `packages/admin/src/views/Dashboard.tsx` | 改 | 工具列加「重新同步本期帳單」+ 預覽 Modal + 通知勾選框 |
| `packages/worker/test/core/payments-unverify.test.ts` | 建 | unverify 狀態機 + 函式 |
| `packages/worker/test/core/billing-reconcile.test.ts` | 建 | `reconcilePeriodBills` 各情境 |
| `packages/worker/test/adapters/discord-nudge.test.ts` | 建 | `sendPaymentNudge` |
| `packages/worker/test/routes/payment-crud.test.ts` | 建 | delete / unverify / sync 路由 + updateUser COALESCE |

---

# Phase 1 — 繳費紀錄狀態機 + CRUD 後端

### Task 1: `verified→pending` 轉換 + `unverifyPayment`

**Files:**
- Modify: `packages/worker/src/core/payments.ts:32-37` (PAYMENT_TRANSITIONS)、檔尾加函式
- Test: `packages/worker/test/core/payments-unverify.test.ts`

**Interfaces:**
- Consumes: 既有 `applyTransition(db, id, to, setClause, binds)`、`getPayment`、`PAYMENT_TRANSITIONS`。
- Produces: `unverifyPayment(db: D1Database, id: number): Promise<PaymentRow>`。

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/worker/test/core/payments-unverify.test.ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { unverifyPayment, verifyPayment, InvalidPaymentTransition, PAYMENT_TRANSITIONS } from "../../src/core/payments";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9110, SUB = 9110;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS,WS,"U",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,WS,"P","x",315,TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB,WS,WS,WS,"2027-01-01",5,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,verified_by,verified_at,verified_channel_tag_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9111,WS,SUB,"2027-01","2027-01-01","2027-01-31","2027-01-05",315,"verified","cron","admin",TS,1,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9112,WS,SUB,"2027-02","2027-02-01","2027-02-28","2027-02-05",315,"pending","cron",TS,TS),
  ]);
});

describe("unverifyPayment", () => {
  it("allows verified -> pending in the state machine", () => {
    expect(PAYMENT_TRANSITIONS.verified).toContain("pending");
  });
  it("reverts a verified payment to pending and clears verification fields", async () => {
    const after = await unverifyPayment(env.DB, 9111);
    expect(after.status).toBe("pending");
    expect(after.verified_by).toBeNull();
    expect(after.verified_at).toBeNull();
    expect(after.verified_channel_tag_id).toBeNull();
  });
  it("throws InvalidPaymentTransition on a non-verified payment", async () => {
    await expect(unverifyPayment(env.DB, 9112)).rejects.toBeInstanceOf(InvalidPaymentTransition);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/core/payments-unverify.test.ts`
Expected: FAIL（`unverifyPayment` 未匯出 / `verified` 不含 `pending`）。

- [ ] **Step 3: 實作**

改 `packages/worker/src/core/payments.ts` 的 transitions：

```ts
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ["paid", "verified", "rejected"],
  paid: ["verified", "rejected"],
  rejected: ["paid", "verified"],
  verified: ["pending"], // 撤回驗證：唯一出口，清空驗證欄位
};
```

檔尾新增（`overrideAmount` 之後）：

```ts
/** Undo a verification: verified -> pending, clearing verification fields. */
export async function unverifyPayment(
  db: D1Database,
  id: number
): Promise<PaymentRow> {
  return applyTransition(
    db, id, "pending",
    "verified_by = NULL, verified_at = NULL, verified_channel_tag_id = NULL",
    []
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/core/payments-unverify.test.ts`
Expected: PASS（3 個）。

- [ ] **Step 5: 確認既有 payments 測試沒被轉換改動弄壞**

Run: `pnpm --filter @chippot/worker exec vitest run test/core/`
Expected: 全綠（`allowedSources("pending")` 現會含 `verified`，但 `unverify` 才會走 pending；既有 markPaid/verify/reject 不受影響）。

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/payments.ts packages/worker/test/core/payments-unverify.test.ts
git commit -m "feat(payments): allow verified->pending (unverify) and clear verification fields"
```

---

### Task 2: 撤回驗證路由 `POST /admin/payments/:id/unverify`

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（加 handler + 註冊；import `unverifyPayment`）
- Test: `packages/worker/test/routes/payment-crud.test.ts`（本檔在 Task 3、4 共用，先建）

**Interfaces:**
- Consumes: `unverifyPayment`、`getPayment`、`InvalidPaymentTransition`、`wsId`、`actorOf`、`writeAudit`。
- Produces: 路由 `POST /admin/payments/:id/unverify` → `{ ok:true, payment }`。

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/worker/test/routes/payment-crud.test.ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 1;                 // wsId() ALWAYS returns the seeded default workspace 1 (single-tenant MVP) — ignores ctx
const U = 9200, SUB = 9200;   // high ids; baseline (ws1 + plan 1 = ChatGPT 315) comes from 0002_seed.sql
const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
// Mirror test/routes/admin.test.ts exactly: ctx is { identity }, no workspace header (wsId ignores it).
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

beforeAll(async () => {
  await env.DB.batch([
    // ws 1 + plan 1 already seeded by 0002_seed.sql; add only our member/sub/payment under ws 1.
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U,WS,"U",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB,WS,U,1,"2027-01-01",5,TS,TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,verified_by,verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9201,WS,SUB,"2027-01","2027-01-01","2027-01-31","2027-01-05",315,"verified","cron","admin",TS,TS,TS),
  ]);
});

describe("POST /admin/payments/:id/unverify", () => {
  it("reverts verified -> pending", async () => {
    const res = await call("POST", "/admin/payments/9201/unverify");
    expect(res!.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, verified_by FROM payments WHERE id = ?").bind(9201).first<{status:string;verified_by:string|null}>();
    expect(row?.status).toBe("pending");
    expect(row?.verified_by).toBeNull();
  });
  it("returns 409 when not verified", async () => {
    const res = await call("POST", "/admin/payments/9201/unverify"); // already pending now
    expect(res!.status).toBe(409);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t unverify`
Expected: FAIL（404，路由不存在）。

- [ ] **Step 3: 實作 handler + 註冊**

`admin.ts` import 補 `unverifyPayment`：

```ts
import { getPayment, verifyPayment, rejectPayment, overrideAmount, unverifyPayment, InvalidPaymentTransition } from "../core/payments";
```

handler（放在 `overrideAmountHandler` 附近）：

```ts
async function unverifyPaymentHandler(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await getPayment(env.DB, id);
  if (!before || before.workspace_id !== wsId(ctx)) return errorResponse(404, "not found");
  try {
    const after = await unverifyPayment(env.DB, id);
    await writeAudit(env.DB, { workspaceId: before.workspace_id, actor: actorOf(ctx), action: "payment.unverify", entityType: "payment", entityId: id, before, after });
    return json({ ok: true, payment: after });
  } catch (e) {
    if (e instanceof InvalidPaymentTransition) return errorResponse(409, e.message);
    throw e;
  }
}
```

註冊（在 `.post("/admin/payments/:id/amount", overrideAmountHandler)` 之後）：

```ts
    .post("/admin/payments/:id/unverify", unverifyPaymentHandler)
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t unverify`
Expected: PASS（2 個）。

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payment-crud.test.ts
git commit -m "feat(admin): add POST /admin/payments/:id/unverify"
```

---

### Task 3: 刪除單筆繳費路由 `DELETE /admin/payments/:id`

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（加 handler + 註冊）
- Test: `packages/worker/test/routes/payment-crud.test.ts`（append）

**Interfaces:**
- Consumes: `getPayment`、`env.BUCKET`、`writeAudit`。
- Produces: 路由 `DELETE /admin/payments/:id` → `{ ok:true }`；硬刪 + R2 截圖清理 + upload_token 清理 + audit。

- [ ] **Step 1: 寫失敗測試（append 到 payment-crud.test.ts）**

```ts
describe("DELETE /admin/payments/:id", () => {
  it("hard-deletes any-status payment, cleans token, writes audit", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(9210,WS,SUB,"2027-03","2027-03-01","2027-03-31","2027-03-05",315,"pending","cron",TS,TS),
      env.DB.prepare(`INSERT INTO upload_tokens (token_hash,workspace_id,user_id,period,subscription_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind("h-9210",WS,WS,"2027-03",SUB,TS,TS),
    ]);
    const res = await call("DELETE", "/admin/payments/9210");
    expect(res!.status).toBe(200);
    const gone = await env.DB.prepare("SELECT id FROM payments WHERE id = ?").bind(9210).first();
    expect(gone).toBeNull();
    const tok = await env.DB.prepare("SELECT id FROM upload_tokens WHERE token_hash = ?").bind("h-9210").first();
    expect(tok).toBeNull();
    const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE entity_type='payment' AND entity_id=9210").first<{action:string}>();
    expect(a?.action).toBe("payment.delete");
  });
  it("404 for a payment outside the workspace", async () => {
    // a payment under a different workspace (9299); wsId()=1 ≠ 9299 → 404 before any cascade.
    await env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(9299,"O","o","discord",5,"{}",TS,TS).run();
    await env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(9298,9299,SUB,"2027-04","2027-04-01","2027-04-30","2027-04-05",315,"pending","cron",TS,TS).run();
    const res = await call("DELETE", "/admin/payments/9298");
    expect(res!.status).toBe(404);
  });
});
```

> audit 表為 `audit_logs`，欄位含 `entity_type`/`entity_id`/`actor`（已確認）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t DELETE`
Expected: FAIL（404，路由不存在）。

- [ ] **Step 3: 實作 handler + 註冊**

handler（放在 `deleteProof` 附近）：

```ts
async function deletePayment(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const p = await getPayment(env.DB, id);
  if (!p || p.workspace_id !== wsId(ctx)) return errorResponse(404, "not found");
  if (p.screenshot_key && env.BUCKET) await env.BUCKET.delete(p.screenshot_key).catch(() => {});
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_tokens WHERE workspace_id = ? AND subscription_id = ? AND period = ?").bind(p.workspace_id, p.subscription_id, p.period),
    env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id),
  ]);
  await writeAudit(env.DB, { workspaceId: p.workspace_id, actor: actorOf(ctx), action: "payment.delete", entityType: "payment", entityId: id, before: p, after: { deleted: true } });
  return json({ ok: true });
}
```

註冊（在 `.post("/admin/payments/:id/delete-proof", deleteProof)` 之後）：

```ts
    .delete("/admin/payments/:id", deletePayment)
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t DELETE`
Expected: PASS（2 個）。

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payment-crud.test.ts
git commit -m "feat(admin): add DELETE /admin/payments/:id (hard delete + R2/token cleanup + audit)"
```

---

### Task 4: `updateUser` email/note 改 COALESCE

**Files:**
- Modify: `packages/worker/src/routes/admin.ts:226-228`
- Test: `packages/worker/test/routes/payment-crud.test.ts`（append）

**Interfaces:** 無新介面；修正既有 `PATCH /admin/users/:id` 不再清空未傳的 email/note。

- [ ] **Step 1: 寫失敗測試（append）**

```ts
describe("PATCH /admin/users/:id keeps unspecified email/note", () => {
  it("does not null email/note when omitted", async () => {
    await env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,email,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(9220,WS,"Keep","keep@x.tw","原備註",TS,TS).run();
    const res = await call("PATCH", "/admin/users/9220", { display_name: "Keep2" });
    expect(res!.status).toBe(200);
    const u = await env.DB.prepare("SELECT display_name,email,note FROM users WHERE id=?").bind(9220).first<{display_name:string;email:string|null;note:string|null}>();
    expect(u?.display_name).toBe("Keep2");
    expect(u?.email).toBe("keep@x.tw");
    expect(u?.note).toBe("原備註");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t "keeps unspecified"`
Expected: FAIL（email/note 被清成 null）。

- [ ] **Step 3: 實作**

改 `updateUser` 的 UPDATE（保留 `discord_id = ?` 的解綁語意，只把 email/note 改 COALESCE）：

```ts
    await env.DB.prepare(
      `UPDATE users SET display_name = COALESCE(?, display_name), discord_id = ?, email = COALESCE(?, email), note = COALESCE(?, note), updated_at = ? WHERE id = ?`
    ).bind(b.display_name ?? null, discordId, b.email ?? null, b.note ?? null, nowUtcIso(), id).run();
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t "keeps unspecified"`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payment-crud.test.ts
git commit -m "fix(admin): updateUser should not null email/note when omitted (COALESCE)"
```

### 🔶 Phase 1 邊界：呼叫 Codex review（payments 狀態機 + 三個路由 + COALESCE）。處理意見後進 Phase 2。

---

# Phase 2 — 重新同步本期帳單（後端）

### Task 5: `reconcilePeriodBills` 核心

**Files:**
- Modify: `packages/worker/src/core/billing.ts`（檔尾加型別 + 函式；已 import `nowUtcIso`、`ensurePeriodPayment` 同檔內）
- Test: `packages/worker/test/core/billing-reconcile.test.ts`

**Interfaces:**
- Consumes: 同檔 `ensurePeriodPayment(db, subId, period, { source })`；`nowUtcIso`；`env.DB`、`env.BUCKET`。
- Produces:
  ```ts
  export interface ReconcileLine { payment_id?: number; subscription_id: number; user_id: number;
    user_name: string; plan_name: string; amount: number; from?: number; to?: number;
    discord_id: string | null; screenshot_key?: string | null; }
  export interface ReconcileDiff { opened: boolean; add: ReconcileLine[]; remove: ReconcileLine[];
    reprice: ReconcileLine[]; frozen_count: number; }
  export async function reconcilePeriodBills(env: Env, workspaceId: number, period: string,
    opts: { dryRun: boolean }): Promise<ReconcileDiff>
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/worker/test/core/billing-reconcile.test.ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { reconcilePeriodBills } from "../../src/core/billing";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9300, P = "2027-07";
const U_ADD = 9301, U_STALE = 9302, U_PRICE = 9303, U_PAID = 9304;
const S_ADD = 9301, S_STALE = 9302, S_PRICE = 9303, S_PAID = 9304;
const PLAN = 9300;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS,"W","o","discord",5,"{}",TS,TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN,WS,"GPT","openai",320,TS,TS),
    // four members
    ...[ [U_ADD,"加入者",null], [U_STALE,"退訂者",null], [U_PRICE,"待改價",null], [U_PAID,"已繳者","disc-paid"] ].map(([id,nm,dc]) =>
      env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,discord_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(id,WS,nm,dc,TS,TS)),
    // subs: ADD active(no bill); STALE cancelled(has pending bill); PRICE active(pending bill @315); PAID active(paid bill)
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_ADD,WS,U_ADD,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_STALE,WS,U_STALE,PLAN,"2027-01-01",5,"cancelled",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PRICE,WS,U_PRICE,PLAN,"2027-01-01",5,"active",TS,TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_PAID,WS,U_PAID,PLAN,"2027-01-01",5,"active",TS,TS),
    // billing opened for P
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",P,0,0,0,TS),
    // bills: STALE pending(315), PRICE pending(315 → should reprice to 320), PAID paid(315 frozen)
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_STALE,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PRICE,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"pending","cron",TS,TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS,S_PAID,P,`${P}-01`,`${P}-31`,`${P}-05`,315,"paid","cron",TS,TS),
  ]);
});

describe("reconcilePeriodBills", () => {
  it("dryRun computes add/remove/reprice/frozen without writing", async () => {
    const d = await reconcilePeriodBills(env, WS, P, { dryRun: true });
    expect(d.opened).toBe(true);
    expect(d.add.map(a => a.subscription_id)).toEqual([S_ADD]);
    expect(d.add[0].amount).toBe(320);
    expect(d.remove.map(r => r.subscription_id)).toEqual([S_STALE]);
    expect(d.reprice.map(r => r.subscription_id)).toEqual([S_PRICE]);
    expect(d.reprice[0].from).toBe(315); expect(d.reprice[0].to).toBe(320);
    expect(d.frozen_count).toBe(1);
    // no writes
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,P).first<{c:number}>();
    expect(cnt?.c).toBe(3);
  });
  it("apply adds at current price, removes stale, reprices pending, freezes paid", async () => {
    await reconcilePeriodBills(env, WS, P, { dryRun: false });
    const rows = (await env.DB.prepare("SELECT subscription_id sid, amount, status FROM payments WHERE workspace_id=? AND period=?").bind(WS,P).all<{sid:number;amount:number;status:string}>()).results;
    const bySub = new Map(rows.map(r => [r.sid, r]));
    expect(bySub.has(S_STALE)).toBe(false);               // removed
    expect(bySub.get(S_ADD)?.amount).toBe(320);           // added @ price
    expect(bySub.get(S_PRICE)?.amount).toBe(320);         // repriced
    expect(bySub.get(S_PAID)?.amount).toBe(315);          // frozen
    expect(bySub.get(S_PAID)?.status).toBe("paid");
  });
  it("returns opened:false and no diff for a never-opened period", async () => {
    const d = await reconcilePeriodBills(env, WS, "2099-01", { dryRun: false });
    expect(d.opened).toBe(false);
    expect(d.add).toEqual([]); expect(d.remove).toEqual([]); expect(d.reprice).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/core/billing-reconcile.test.ts`
Expected: FAIL（`reconcilePeriodBills` 未匯出）。

- [ ] **Step 3: 實作（`billing.ts` 檔尾）**

```ts
export interface ReconcileLine {
  payment_id?: number; subscription_id: number; user_id: number;
  user_name: string; plan_name: string; amount: number;
  from?: number; to?: number; discord_id: string | null; screenshot_key?: string | null;
}
export interface ReconcileDiff {
  opened: boolean; add: ReconcileLine[]; remove: ReconcileLine[];
  reprice: ReconcileLine[]; frozen_count: number;
}

/**
 * Reconcile a period's bills against the current active roster (manual "重新同步本期帳單").
 * add: active sub with no bill → pending @ current plan price. remove: pending/rejected bill of a
 * non-active sub → delete (+ R2 proof + upload_token cleanup). reprice: active sub's PENDING bill →
 * current plan price. paid/verified are frozen. Only "opened" periods (has a billing_opened log) act.
 */
export async function reconcilePeriodBills(
  env: Env, workspaceId: number, period: string, opts: { dryRun: boolean }
): Promise<ReconcileDiff> {
  const openedRow = await env.DB
    .prepare("SELECT 1 AS ok FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ? LIMIT 1")
    .bind(workspaceId, period).first<{ ok: number }>();
  if (!openedRow) return { opened: false, add: [], remove: [], reprice: [], frozen_count: 0 };

  const activeSubs = (await env.DB.prepare(
    `SELECT s.id AS subscription_id, s.user_id AS user_id, u.display_name AS user_name, u.discord_id AS discord_id,
            pl.name AS plan_name, pl.monthly_amount AS price
     FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE s.workspace_id = ? AND s.status = 'active'`
  ).bind(workspaceId).all<{ subscription_id: number; user_id: number; user_name: string; discord_id: string | null; plan_name: string; price: number }>()).results;

  const existing = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.amount AS amount, p.status AS status,
            p.screenshot_key AS screenshot_key, s.status AS sub_status, s.user_id AS user_id,
            u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ?`
  ).bind(workspaceId, period).all<{ payment_id: number; subscription_id: number; amount: number; status: string; screenshot_key: string | null; sub_status: string; user_id: number; user_name: string; discord_id: string | null; plan_name: string }>()).results;

  const bySub = new Map(existing.map((e) => [e.subscription_id, e]));
  const add: ReconcileLine[] = [], reprice: ReconcileLine[] = [], remove: ReconcileLine[] = [];
  let frozen_count = 0;

  for (const s of activeSubs) {
    const e = bySub.get(s.subscription_id);
    if (!e) {
      add.push({ subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: s.price, discord_id: s.discord_id });
    } else if (e.status === "pending" && e.amount !== s.price) {
      reprice.push({ payment_id: e.payment_id, subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: s.price, from: e.amount, to: s.price, discord_id: s.discord_id });
    }
  }
  for (const e of existing) {
    if (e.status === "paid" || e.status === "verified") { frozen_count++; continue; }
    if (e.sub_status !== "active") {
      remove.push({ payment_id: e.payment_id, subscription_id: e.subscription_id, user_id: e.user_id, user_name: e.user_name, plan_name: e.plan_name, amount: e.amount, discord_id: e.discord_id, screenshot_key: e.screenshot_key });
    }
  }

  if (opts.dryRun) return { opened: true, add, remove, reprice, frozen_count };

  const now = nowUtcIso();
  for (const a of add) {
    const r = await ensurePeriodPayment(env.DB, a.subscription_id, period, { source: "reconcile" });
    a.payment_id = r.paymentId; // ensurePeriodPayment inserts at current plan price
  }
  const stmts: D1PreparedStatement[] = [];
  for (const rp of reprice) stmts.push(env.DB.prepare("UPDATE payments SET amount = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(rp.to!, now, rp.payment_id!));
  for (const rm of remove) {
    stmts.push(env.DB.prepare("DELETE FROM upload_tokens WHERE workspace_id = ? AND subscription_id = ? AND period = ?").bind(workspaceId, rm.subscription_id, period));
    stmts.push(env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(rm.payment_id!));
  }
  if (stmts.length) await env.DB.batch(stmts);
  const keys = [...new Set(remove.map((r) => r.screenshot_key).filter((k): k is string => !!k))];
  if (env.BUCKET) for (const k of keys) await env.BUCKET.delete(k).catch(() => {});

  return { opened: true, add, remove, reprice, frozen_count };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/core/billing-reconcile.test.ts`
Expected: PASS（3 個）。

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/billing.ts packages/worker/test/core/billing-reconcile.test.ts
git commit -m "feat(billing): reconcilePeriodBills (add/remove/reprice/freeze + preview)"
```

---

### Task 6: `sendPaymentNudge` 通知

**Files:**
- Modify: `packages/worker/src/core/notify.ts`（`Notifier` 介面）、`packages/worker/src/adapters/discord/notify.ts`（實作）
- Test: `packages/worker/test/adapters/discord-nudge.test.ts`

**Interfaces:**
- Consumes: 既有 `OverduePerson`（`{ user_id, discord_id, user_name, lines:{plan_name,amount}[], total }`）、`createChannelMessage`、`payButtonRow`。
- Produces: `Notifier.sendPaymentNudge(env, channelId, workspaceId, period, people): Promise<void>`。

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/worker/test/adapters/discord-nudge.test.ts
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/adapters/discord-nudge.test.ts`
Expected: FAIL（`sendPaymentNudge` 不存在）。

- [ ] **Step 3: 實作**

`core/notify.ts` 的 `Notifier` 介面加（在 `sendOverdue` 之後）：

```ts
  sendPaymentNudge(env: Env, channelId: string, workspaceId: number, period: string, people: OverduePerson[]): Promise<void>;
```

`adapters/discord/notify.ts` 的 `discordNotifier` 加方法（沿用 `sendOverdue` 的 mention 模式）：

```ts
  async sendPaymentNudge(env: Env, channelId, workspaceId: number, period, people: OverduePerson[]) {
    const list = people
      .map((p) => {
        const mention = p.discord_id ? `<@${p.discord_id}>` : `**${p.user_name}**`;
        const plans = p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`).join("、");
        return `・${mention} ${plans}（合計 NT$${p.total.toLocaleString()}）`;
      })
      .join("\n");
    const content = `📋 已將你加入 ${period} 繳費名單：\n${list}\n請點下方按鈕繳費。`;
    const users = [...new Set(people.map((p) => p.discord_id).filter((d): d is string => !!d))];
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow(workspaceId)],
      allowed_mentions: { parse: [], users },
    });
  },
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/adapters/discord-nudge.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/notify.ts packages/worker/src/adapters/discord/notify.ts packages/worker/test/adapters/discord-nudge.test.ts
git commit -m "feat(notify): sendPaymentNudge (targeted @mention + pay button)"
```

---

### Task 7: 同步路由 `POST /admin/billing/:period/sync`

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（import `reconcilePeriodBills`、`OverduePerson`；handler + 註冊）
- Test: `packages/worker/test/routes/payment-crud.test.ts`（append）

**Interfaces:**
- Consumes: `reconcilePeriodBills`、`discordNotifier.sendPaymentNudge`、`parseSettings`、`OverduePerson`。
- Produces: 路由 `POST /admin/billing/:period/sync`；body `{ dry_run?: boolean, notify_added?: boolean }`。dryRun 預設 true（除非顯式 `false`）。

- [ ] **Step 1: 寫失敗測試（append；沿用 Task 2 的 WS=9200 seed 與 `call`）**

```ts
// NOTE: route tests run on the shared seeded workspace 1 (wsId()===1), which carries the
// 0002_seed.sql baseline roster. So assert RELATIVE behavior (our SUB + dry-run-writes-nothing),
// not exact totals — precise add/remove/reprice/freeze counts are covered by Task 5's isolated core test.
describe("POST /admin/billing/:period/sync", () => {
  const PER = "2027-09"; // a fresh opened period where our active SUB has no bill yet
  it("dry_run returns diff including our sub and writes nothing", async () => {
    await env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,sent_at) VALUES (?,?,?,?,?,?,?)`).bind(WS,"billing_opened",PER,0,0,0,TS).run();
    const before = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,PER).first<{c:number}>())?.c ?? 0;
    const res = await call("POST", `/admin/billing/${PER}/sync`, { dry_run: true });
    expect(res!.status).toBe(200);
    const d = await res!.json() as any;
    expect(d.opened).toBe(true);
    expect(d.add.some((a: any) => a.subscription_id === SUB)).toBe(true);
    const after = (await env.DB.prepare("SELECT COUNT(*) c FROM payments WHERE workspace_id=? AND period=?").bind(WS,PER).first<{c:number}>())?.c ?? 0;
    expect(after).toBe(before); // dry run wrote nothing
  });
  it("apply creates the missing bill and returns counts", async () => {
    const res = await call("POST", `/admin/billing/${PER}/sync`, { dry_run: false });
    const r = await res!.json() as any;
    expect(r.ok).toBe(true);
    expect(r.applied.added).toBeGreaterThanOrEqual(1);
    const mine = await env.DB.prepare("SELECT id FROM payments WHERE subscription_id=? AND period=?").bind(SUB,PER).first();
    expect(mine).not.toBeNull();
  });
  it("rejects a malformed period", async () => {
    const res = await call("POST", "/admin/billing/2027-9/sync", { dry_run: true });
    expect(res!.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t sync`
Expected: FAIL（404）。

- [ ] **Step 3: 實作 handler + 註冊**

import 補：

```ts
import { ensureFirstPayment, initiateBillingOpened, reconcilePeriodBills } from "../core/billing";
import type { OverduePerson } from "../core/notify";
```

handler（放在 `billingInitiate` 附近）：

```ts
async function syncPeriodBills(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const period = ctx.params.period;
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const b = await readJson<{ dry_run?: boolean; notify_added?: boolean }>(req) ?? {};
  const dryRun = b.dry_run !== false; // safe default: preview unless explicitly false
  const diff = await reconcilePeriodBills(env, ws, period, { dryRun });
  if (dryRun) return json(diff);

  await writeAudit(env.DB, {
    workspaceId: ws, actor: actorOf(ctx), action: "billing.reconcile", entityType: "workspace", entityId: ws,
    after: { period, added: diff.add.length, removed: diff.remove.length, repriced: diff.reprice.length, frozen: diff.frozen_count },
  });

  let notified = 0;
  if (b.notify_added && diff.add.length) {
    const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
    const settings = parseSettings(wsRow!.settings);
    const channelId = settings.discord_billing_channel_id;
    if (channelId && env.DISCORD_BOT_TOKEN) {
      const byUser = new Map<number, OverduePerson>();
      for (const a of diff.add) {
        if (!a.discord_id) continue;
        let e = byUser.get(a.user_id);
        if (!e) { e = { user_id: a.user_id, discord_id: a.discord_id, user_name: a.user_name, lines: [], total: 0 }; byUser.set(a.user_id, e); }
        e.lines.push({ plan_name: a.plan_name, amount: a.amount });
        e.total += a.amount;
      }
      const people = [...byUser.values()];
      if (people.length) { await discordNotifier.sendPaymentNudge(env, channelId, ws, period, people); notified = people.length; }
    }
  }
  return json({ ok: true, applied: { added: diff.add.length, removed: diff.remove.length, repriced: diff.reprice.length, frozen: diff.frozen_count }, notified });
}
```

註冊（在 `.post("/admin/billing/initiate", billingInitiate)` 之後）：

```ts
    .post("/admin/billing/:period/sync", syncPeriodBills)
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @chippot/worker exec vitest run test/routes/payment-crud.test.ts -t sync`
Expected: PASS（3 個）。

- [ ] **Step 5: 全 worker 測試**

Run: `pnpm --filter @chippot/worker exec vitest run`
Expected: 全綠。

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/payment-crud.test.ts
git commit -m "feat(admin): POST /admin/billing/:period/sync (reconcile + optional new-member nudge)"
```

### 🔶 Phase 2 邊界：呼叫 Codex review（reconcile 核心 + nudge + sync 路由）。處理意見後進 Phase 3。

---

# Phase 3 — 前端

### Task 8: `api.ts` 三個方法

**Files:**
- Modify: `packages/admin/src/api.ts`
- Test: 手動（前端無單測；型別編譯即驗證）

**Interfaces:**
- Produces: `api.deletePayment(id)`、`api.unverify(id)`、`api.syncPeriodBills(period, opts)`，及型別 `ReconcileDiff`。

- [ ] **Step 1: 加型別 + 方法**

`api.ts` 加型別（與後端對齊）：

```ts
export interface ReconcileLine { payment_id?: number; subscription_id: number; user_id: number; user_name: string; plan_name: string; amount: number; from?: number; to?: number; discord_id: string | null; }
export interface ReconcileDiff { opened: boolean; add: ReconcileLine[]; remove: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number; }
```

`api` 物件加（放在 payments 相關方法旁）：

```ts
  deletePayment: (id: number) => req("DELETE", `/payments/${id}`),
  unverify: (id: number) => req<{ ok: boolean }>("POST", `/payments/${id}/unverify`),
  syncPeriodBills: (period: string, opts: { dry_run: boolean; notify_added?: boolean }) =>
    req<ReconcileDiff | { ok: boolean; applied: { added: number; removed: number; repriced: number; frozen: number }; notified: number }>("POST", `/billing/${period}/sync`, opts),
```

- [ ] **Step 2: 型別檢查**

Run: `pnpm --filter @chippot/admin exec tsc --noEmit`
Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add packages/admin/src/api.ts
git commit -m "feat(admin-ui): api methods deletePayment/unverify/syncPeriodBills"
```

---

### Task 9: `PaymentDetail` 加「刪除此筆」「撤回驗證」

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx`（`PaymentDetail` 元件）
- Test: 手動（本機 admin）

**Interfaces:**
- Consumes: `api.deletePayment`、`api.unverify`、既有 `run(fn)` helper、`onDone`。

- [ ] **Step 1: 在 `PaymentDetail` 加按鈕區**

在 `PaymentDetail` 的 `<div className="btn-row">` 後加（撤回驗證只在 verified 顯示）：

```tsx
      {payment.status === "verified" && (
        <button className="btn" disabled={busy} onClick={() => run(() => api.unverify(payment.id))}>撤回驗證</button>
      )}
```

在 modal 底部加刪除區（強確認）：

```tsx
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "18px 0" }} />
      <button
        className="btn btn--danger"
        disabled={busy}
        onClick={() => {
          const settled = payment.status === "paid" || payment.status === "verified";
          const msg = settled
            ? "這是已收款紀錄，刪除後會從對帳消失且無法復原（仍保留稽核紀錄）。確定刪除？"
            : "確定刪除這筆繳費紀錄？（保留稽核紀錄）";
          if (window.confirm(msg)) run(() => api.deletePayment(payment.id));
        }}
      >刪除此筆</button>
```

- [ ] **Step 2: 型別檢查 + 本機驗證**

Run: `pnpm --filter @chippot/admin exec tsc --noEmit`
本機：開 admin，點一筆 verified → 撤回驗證 → 變待繳；點刪除 → 確認 → 消失。

- [ ] **Step 3: Commit**

```bash
git add packages/admin/src/views/Payments.tsx
git commit -m "feat(admin-ui): payment detail — unverify + delete (strong confirm)"
```

---

### Task 10: Dashboard「重新同步本期帳單」+ 預覽 Modal + 通知勾選

**Files:**
- Modify: `packages/admin/src/views/Dashboard.tsx`（工具列 + 新 `SyncModal` 元件）
- Test: 手動（本機 admin）

**Interfaces:**
- Consumes: `api.syncPeriodBills`、`ReconcileDiff`、`Modal`、`Money`。

- [ ] **Step 1: 工具列加按鈕 + state**

`Dashboard()` 工具列（`<div className="toolbar">`）內、期別 input 之後加：

```tsx
        <div className="grow" style={{ flex: 1 }} />
        <button className="btn btn--primary" onClick={() => setSync(true)}>重新同步本期帳單</button>
```

`Dashboard()` 內加 state 與 modal 掛載：

```tsx
  const [sync, setSync] = useState(false);
  // …在 return 的最後（</> 之前）：
  {sync && <SyncModal period={effPeriod} onClose={() => setSync(false)} onDone={() => { setSync(false); /* reload stats */ }} />}
```

> `useAsync` 的 reload：把 `const { data, loading, error } = useAsync(...)` 改成 `const recon = useAsync(...)`，並在 `onDone` 呼叫 `recon.reload()`（或保留現名並另取 reload）。對齊既有 `useAsync` 介面。

- [ ] **Step 2: 新增 `SyncModal` 元件（同檔）**

```tsx
import { api, periodForBillingDay, type ReconcileDiff } from "../api";
import { useAsync, Card, Stat, Empty, Money, Modal } from "../ui";

function SyncModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [diff, setDiff] = useState<ReconcileDiff | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.syncPeriodBills(period, { dry_run: true })
      .then((d) => { if (!off) { setDiff(d as ReconcileDiff); setBusy(false); } })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  const boundAdds = diff?.add.filter((a) => a.discord_id) ?? [];

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const r = await api.syncPeriodBills(period, { dry_run: false, notify_added: notify && boundAdds.length > 0 }) as any;
      setDone(`已套用：新增 ${r.applied.added}、移除 ${r.applied.removed}、改價 ${r.applied.repriced}、保留 ${r.applied.frozen}` + (r.notified ? `；已通知 ${r.notified} 位` : ""));
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`重新同步本期帳單 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !diff && <Empty>計算差異中…</Empty>}
      {done && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{done}</div>}
      {diff && !diff.opened && !done && <p style={{ color: "var(--muted)" }}>此期尚未發起繳費，無需同步。</p>}
      {diff && diff.opened && !done && (
        <>
          <div className="stats">
            <Stat label="➕ 新增" value={diff.add.length} />
            <Stat label="➖ 移除" value={diff.remove.length} />
            <Stat label="🔄 改價" value={diff.reprice.length} />
            <Stat label="🔒 保留(已繳)" value={diff.frozen_count} />
          </div>
          {diff.add.length > 0 && <DiffList title="新增" rows={diff.add.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {diff.remove.length > 0 && <DiffList title="移除（已退訂）" rows={diff.remove.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {diff.reprice.length > 0 && <DiffList title="改價" rows={diff.reprice.map((a) => `${a.user_name}·${a.plan_name} ${a.from}→${a.to}`)} />}
          {boundAdds.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              在頻道 @ 通知這 {boundAdds.length} 位新成員並附繳費按鈕
            </label>
          )}
          <button className="btn btn--primary" disabled={busy} onClick={apply}>確認套用</button>
        </>
      )}
    </Modal>
  );
}

function DiffList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <details style={{ margin: "6px 0" }}>
      <summary style={{ cursor: "pointer" }}>{title}（{rows.length}）</summary>
      <ul style={{ margin: "6px 0 0 18px", color: "var(--muted-strong)", fontSize: 13 }}>
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </details>
  );
}
```

> 確保 `import { useEffect } from "react"`（Dashboard 目前只 import `useState`，需補 `useEffect`）。`Modal` 來自 `../ui`。

- [ ] **Step 3: 型別檢查 + 本機驗證**

Run: `pnpm --filter @chippot/admin exec tsc --noEmit`
本機：對帳看板選一個已開期別 → 重新同步 → 看差異卡 → 勾選 → 確認套用 → toast + 統計刷新。未開期別顯示「尚未發起繳費」。

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Dashboard.tsx
git commit -m "feat(admin-ui): dashboard reconcile period bills (preview + notify-added)"
```

### 🔶 Phase 3 邊界：呼叫 Codex review（前端三檔）。處理意見。

---

## 收尾

- [ ] 全 worker 測試：`pnpm --filter @chippot/worker exec vitest run`（全綠）。
- [ ] admin 型別：`pnpm --filter @chippot/admin exec tsc --noEmit`。
- [ ] 開 PR；合併後**手動部署**（worker：`pnpm --filter @chippot/worker run deploy`；admin：`pnpm --filter @chippot/admin exec wrangler pages deploy dist --project-name chippot-admin --branch main`）。merge 不會自動觸發 CD。
- [ ] 部署後記 `docs/deploy-state.md`（gitignored，本機）。
- [ ] 之後接「常駐公開綁定按鈕」（memory `chippo-bind-button-queued`）：補 spec → plan → 實作。

---

## Self-Review（plan vs spec）

**Spec 覆蓋**：功能 1 reconcile = Task 5/7/10；功能 2 nudge = Task 6 + Task 7 wiring + Task 10 checkbox；功能 3 delete = Task 3 + Task 9；功能 4 unverify = Task 1/2 + Task 9；小坑 updateUser = Task 4；測試 = 各 task 內含。✓

**Placeholder 掃描**：無 TBD/TODO；每個 code step 皆含完整程式碼。一處需執行者對齊既有慣例：Task 2 的 route 測試 workspace ctx 注入（`call()` helper）——已標註「照抄既有 `test/routes/` helper」。

**型別一致**：`ReconcileLine`/`ReconcileDiff` 後端（Task 5）與前端（Task 8）欄位一致；`reconcilePeriodBills` 簽章在 Task 5 定義、Task 7 消費一致；`sendPaymentNudge(env, channelId, workspaceId, period, people)` 在 Task 6 定義、Task 7 以同序呼叫；`unverifyPayment(db, id)` Task 1 定義、Task 2 消費。✓
