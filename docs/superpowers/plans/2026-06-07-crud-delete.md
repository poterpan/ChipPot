# 成員/訂閱/方案/渠道 刪除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補齊後台刪除能力——user/subscription 為 cascade 硬刪（連帶 payments + upload_tokens + R2 截圖），plan/channel_tag 為 guarded 硬刪（被參照則 409，仍可停用），含確認 UI 與 audit。

**Architecture:** worker `routes/admin.ts` 新增 4 個 Access 保護的 DELETE handler + router 註冊；child→parent 順序刪除（即使 D1 強制外鍵也安全），R2 物件清理依 `env.BUCKET` guard。list 端點加計數欄位驅動前端確認框與 guarded 防呆。前端 `Manage.tsx` 每實體加刪除鈕 + 確認 Modal。

**Tech Stack:** Cloudflare Workers + D1 + R2，pnpm monorepo，TypeScript，Vitest，React SPA（Vite）。

**Spec:** `docs/superpowers/specs/2026-06-07-crud-delete-design.md`

**前置：** 分支 `feat/crud-delete`（已建立，off 合併後 main）。每個 Task 結束 commit。全程基準：`pnpm -r typecheck`、`pnpm --filter @chippot/worker test`、`pnpm -r build` 維持綠燈；worker 測試在「無 `.dev.vars`」下也須全綠。已知事實：`Router` 支援 `.delete()`（router.ts:46）；admin.ts 內 R2 物件以 `env.BUCKET.delete(key)` 直接刪除（如既有 `deleteProof`，無需額外 import）；`createSubscription` 會自動建第一期 payment（故新建訂閱即有 1 筆 payment）。

---

## File Structure

| 檔案 | 責任 | Task |
|---|---|---|
| `packages/worker/src/routes/admin.ts` | 4 DELETE handler + router；4 list 加計數 | 1,2,3 |
| `packages/worker/test/routes/admin.test.ts` | DELETE cascade/guarded/audit/R2 + 計數測試 | 1,2,3 |
| `packages/admin/src/api.ts` | 4 delete 方法 + 4 interface 計數欄位 | 4 |
| `packages/admin/src/views/Manage.tsx` | 4 區塊刪除鈕 + 確認 Modal | 4 |

---

## Task 1: cascade 硬刪（成員 + 訂閱）

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（新增 `deleteUser`、`deleteSubscription` + router）
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `packages/worker/test/routes/admin.test.ts` 的 `describe("admin API", ...)` 內新增：
```ts
  it("cascade-deletes a member with subscriptions + payments (+audit)", async () => {
    const u = await call("POST", "/admin/users", { display_name: "DelMe", discord_id: "d-delme" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-01-01" });
    const sid = ((await s!.json()) as any).id as number; // createSubscription auto-creates 1 payment
    const del = await call("DELETE", `/admin/users/${uid}`);
    expect(del!.status).toBe(200);
    const body = (await del!.json()) as any;
    expect(body.deleted.subscriptions).toBe(1);
    expect(body.deleted.payments).toBeGreaterThanOrEqual(1);
    expect((await call("GET", "/admin/users"))!.status).toBe(200);
    const users = ((await (await call("GET", "/admin/users"))!.json()) as any).users;
    expect(users.find((x: any) => x.id === uid)).toBeUndefined();
    const leftoverSub = await env.DB.prepare("SELECT id FROM subscriptions WHERE id = ?").bind(sid).first();
    expect(leftoverSub).toBeNull();
    const leftoverPay = await env.DB.prepare("SELECT COUNT(*) AS c FROM payments WHERE subscription_id = ?").bind(sid).first<{ c: number }>();
    expect(leftoverPay?.c).toBe(0);
    expect(await auditCount("user.delete", uid)).toBe(1);
  });

  it("cascade-deletes a subscription with its payments, leaving the member", async () => {
    const u = await call("POST", "/admin/users", { display_name: "KeepMe" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-02-01" });
    const sid = ((await s!.json()) as any).id as number;
    const del = await call("DELETE", `/admin/subscriptions/${sid}`);
    expect(del!.status).toBe(200);
    expect(((await del!.json()) as any).deleted.payments).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM subscriptions WHERE id = ?").bind(sid).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first()).not.toBeNull(); // member kept
    expect(await auditCount("subscription.delete", sid)).toBe(1);
  });

  it("cascade-deletes cleanly when R2 is not configured (proof rows present)", async () => {
    const u = await call("POST", "/admin/users", { display_name: "NoR2Del" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-03-01" });
    const sid = ((await s!.json()) as any).id as number;
    await env.DB.prepare("UPDATE payments SET screenshot_key = ? WHERE subscription_id = ?").bind("1/2031-03/x/p.png", sid).run();
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const del = await call("DELETE", `/admin/users/${uid}`);
    (env as any).BUCKET = prev;
    expect(del!.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first()).toBeNull();
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/poterpan/Documents/Coding/Project/chippot && pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "cascade|FAIL|Tests "`
Expected: 失敗（route 不存在 → 405/404，斷言失敗）。

- [ ] **Step 3: 新增 `deleteUser` + `deleteSubscription` handler**

在 `packages/worker/src/routes/admin.ts` 的 `updateUser` 函式之後（`// ── Plans ──` 註解之前）插入：
```ts
async function deleteUser(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const ws = wsId(ctx);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND workspace_id = ?").bind(id, ws).first();
  if (!user) return errorResponse(404, "not found");

  // Delete R2 proof objects for this user's payments (dedup; R2 may be absent → skip).
  if (env.BUCKET) {
    const keys = await env.DB.prepare(
      `SELECT DISTINCT p.screenshot_key AS k FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE s.user_id = ? AND s.workspace_id = ? AND p.screenshot_key IS NOT NULL`
    ).bind(id, ws).all<{ k: string }>();
    for (const { k } of keys.results) await env.BUCKET.delete(k).catch(() => {});
  }

  const subCount = (await env.DB.prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = ? AND workspace_id = ?").bind(id, ws).first<{ c: number }>())?.c ?? 0;
  const payCount = (await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ? AND workspace_id = ?)"
  ).bind(id, ws).first<{ c: number }>())?.c ?? 0;

  // child → parent
  await env.DB.prepare("DELETE FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ? AND workspace_id = ?)").bind(id, ws).run();
  await env.DB.prepare("DELETE FROM upload_tokens WHERE user_id = ? AND workspace_id = ?").bind(id, ws).run();
  await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND workspace_id = ?").bind(id, ws).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ? AND workspace_id = ?").bind(id, ws).run();

  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "user.delete", entityType: "user", entityId: id, before: user, after: { deleted: { subscriptions: subCount, payments: payCount } } });
  return json({ ok: true, deleted: { subscriptions: subCount, payments: payCount } });
}

async function deleteSubscription(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const ws = wsId(ctx);
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ? AND workspace_id = ?").bind(id, ws).first();
  if (!sub) return errorResponse(404, "not found");

  if (env.BUCKET) {
    const keys = await env.DB.prepare("SELECT DISTINCT screenshot_key AS k FROM payments WHERE subscription_id = ? AND screenshot_key IS NOT NULL").bind(id).all<{ k: string }>();
    for (const { k } of keys.results) await env.BUCKET.delete(k).catch(() => {});
  }

  const payCount = (await env.DB.prepare("SELECT COUNT(*) AS c FROM payments WHERE subscription_id = ?").bind(id).first<{ c: number }>())?.c ?? 0;
  await env.DB.prepare("DELETE FROM payments WHERE subscription_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM upload_tokens WHERE subscription_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM subscriptions WHERE id = ? AND workspace_id = ?").bind(id, ws).run();

  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "subscription.delete", entityType: "subscription", entityId: id, before: sub, after: { deleted: { payments: payCount } } });
  return json({ ok: true, deleted: { payments: payCount } });
}
```

- [ ] **Step 4: 註冊路由**

在 `buildAdminRouter()` 的 `.patch("/admin/users/:id", updateUser)` 之後加 `.delete("/admin/users/:id", deleteUser)`；在 `.patch("/admin/subscriptions/:id", updateSubscription)` 之後加 `.delete("/admin/subscriptions/:id", deleteSubscription)`。例如：
```ts
    .patch("/admin/users/:id", updateUser)
    .delete("/admin/users/:id", deleteUser)
```
```ts
    .patch("/admin/subscriptions/:id", updateSubscription)
    .delete("/admin/subscriptions/:id", deleteSubscription)
```

- [ ] **Step 5: 跑測試確認通過（含無 .dev.vars）+ typecheck**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm --filter @chippot/worker test 2>&1 | grep -E "Test Files|Tests "
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 無錯；全綠、無 failed（baseline 170 + 3 新 → 173）。ALWAYS restore .dev.vars。

- [ ] **Step 6: Commit**
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin): cascade-delete members and subscriptions

DELETE /admin/users/:id and /admin/subscriptions/:id remove the entity plus its
payments, upload_tokens, and R2 proof objects (child→parent; R2 cleanup guarded by
env.BUCKET). Returns deletion counts and writes an audit log."
```

---

## Task 2: guarded 硬刪（方案 + 渠道）

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（新增 `deletePlan`、`deleteChannelTag` + router）
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `describe("admin API", ...)` 內新增：
```ts
  it("plan delete is blocked (409) while subscriptions reference it, allowed when none", async () => {
    const p = await call("POST", "/admin/plans", { name: "DelPlan", provider: "openai", monthly_amount: 100 });
    const pid = ((await p!.json()) as any).id as number;
    const u = await call("POST", "/admin/users", { display_name: "PlanRef" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: pid, start_date: "2031-04-01" });
    const sid = ((await s!.json()) as any).id as number;
    expect((await call("DELETE", `/admin/plans/${pid}`))!.status).toBe(409); // referenced
    await call("DELETE", `/admin/subscriptions/${sid}`); // remove the only reference
    const del = await call("DELETE", `/admin/plans/${pid}`);
    expect(del!.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM plans WHERE id = ?").bind(pid).first()).toBeNull();
    expect(await auditCount("plan.delete", pid)).toBe(1);
  });

  it("channel-tag delete is blocked (409) while a payment references it, allowed when none", async () => {
    const t = await call("POST", "/admin/channel-tags", { name: "DelTag", type: "bank" });
    const tid = ((await t!.json()) as any).id as number;
    const u = await call("POST", "/admin/users", { display_name: "TagRef" });
    const uid = ((await u!.json()) as any).id as number;
    const s = await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-05-01" });
    const sid = ((await s!.json()) as any).id as number;
    // reference the tag from a payment (declared_channel_tag_id)
    await env.DB.prepare("UPDATE payments SET declared_channel_tag_id = ? WHERE subscription_id = ?").bind(tid, sid).run();
    expect((await call("DELETE", `/admin/channel-tags/${tid}`))!.status).toBe(409);
    await env.DB.prepare("UPDATE payments SET declared_channel_tag_id = NULL WHERE subscription_id = ?").bind(sid).run();
    const del = await call("DELETE", `/admin/channel-tags/${tid}`);
    expect(del!.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM channel_tags WHERE id = ?").bind(tid).first()).toBeNull();
    expect(await auditCount("channel_tag.delete", tid)).toBe(1);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/poterpan/Documents/Coding/Project/chippot && pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "blocked|FAIL|Tests "`
Expected: 失敗（route 不存在）。

- [ ] **Step 3: 新增 `deletePlan` handler**

在 `admin.ts` 的 `updatePlan` 之後（`// ── Subscriptions ──` 之前）插入：
```ts
async function deletePlan(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const ws = wsId(ctx);
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ? AND workspace_id = ?").bind(id, ws).first();
  if (!plan) return errorResponse(404, "not found");
  const ref = await env.DB.prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE plan_id = ? AND workspace_id = ?").bind(id, ws).first<{ c: number }>();
  if ((ref?.c ?? 0) > 0) return errorResponse(409, "此方案仍有訂閱，請先刪除訂閱或改用停用");
  await env.DB.prepare("DELETE FROM plans WHERE id = ? AND workspace_id = ?").bind(id, ws).run();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "plan.delete", entityType: "plan", entityId: id, before: plan });
  return json({ ok: true });
}
```

- [ ] **Step 4: 新增 `deleteChannelTag` handler**

在 `admin.ts` 的 `updateChannelTag` 之後（`// ── Payments ──` 之前）插入：
```ts
async function deleteChannelTag(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const ws = wsId(ctx);
  const tag = await env.DB.prepare("SELECT * FROM channel_tags WHERE id = ? AND workspace_id = ?").bind(id, ws).first();
  if (!tag) return errorResponse(404, "not found");
  const ref = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM payments WHERE workspace_id = ? AND (verified_channel_tag_id = ? OR declared_channel_tag_id = ?)"
  ).bind(ws, id, id).first<{ c: number }>();
  if ((ref?.c ?? 0) > 0) return errorResponse(409, "此渠道已被繳費紀錄參照，請改用停用");
  await env.DB.prepare("DELETE FROM channel_tags WHERE id = ? AND workspace_id = ?").bind(id, ws).run();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "channel_tag.delete", entityType: "channel_tag", entityId: id, before: tag });
  return json({ ok: true });
}
```

- [ ] **Step 5: 註冊路由**

在 `.patch("/admin/plans/:id", updatePlan)` 之後加 `.delete("/admin/plans/:id", deletePlan)`；在 `.patch("/admin/channel-tags/:id", updateChannelTag)` 之後加 `.delete("/admin/channel-tags/:id", deleteChannelTag)`。

- [ ] **Step 6: 跑測試 + typecheck（含無 .dev.vars）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm --filter @chippot/worker test 2>&1 | grep -E "Test Files|Tests "
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 無錯；全綠、無 failed（173 + 2 → 175）。

- [ ] **Step 7: Commit**
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin): guarded delete for plans and channel tags

DELETE /admin/plans/:id and /admin/channel-tags/:id hard-delete only when nothing
references them (a subscription / a payment), else 409. Soft-deactivate via active
remains. Writes an audit log."
```

---

## Task 3: list 端點加計數（給確認框 + guarded 防呆）

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（`listUsers`、`listSubscriptions`、`listPlans`、`listChannelTags`）
- Test: `packages/worker/test/routes/admin.test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `describe("admin API", ...)` 內新增：
```ts
  it("list endpoints report dependency counts", async () => {
    const u = await call("POST", "/admin/users", { display_name: "Counter" });
    const uid = ((await u!.json()) as any).id as number;
    await call("POST", "/admin/subscriptions", { user_id: uid, plan_id: 1, start_date: "2031-06-01" }); // 1 sub, 1 payment
    const users = ((await (await call("GET", "/admin/users"))!.json()) as any).users;
    const row = users.find((x: any) => x.id === uid);
    expect(row.subscription_count).toBe(1);
    expect(row.payment_count).toBeGreaterThanOrEqual(1);
    const subs = ((await (await call("GET", "/admin/subscriptions"))!.json()) as any).subscriptions;
    expect(subs.every((s: any) => typeof s.payment_count === "number")).toBe(true);
    const plans = ((await (await call("GET", "/admin/plans"))!.json()) as any).plans;
    expect(plans.find((p: any) => p.id === 1)?.subscription_count).toBeGreaterThanOrEqual(1);
    const tags = ((await (await call("GET", "/admin/channel-tags"))!.json()) as any).channel_tags;
    expect(tags.every((t: any) => typeof t.usage_count === "number")).toBe(true);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/poterpan/Documents/Coding/Project/chippot && pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "dependency counts|FAIL|Tests "`
Expected: 失敗（count 欄位為 undefined）。

- [ ] **Step 3: `listUsers` 加計數**

把 `listUsers`（約 175-179）的 SQL 改為：
```ts
async function listUsers(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subscription_count,
              (SELECT COUNT(*) FROM payments p JOIN subscriptions s2 ON s2.id = p.subscription_id WHERE s2.user_id = u.id) AS payment_count
       FROM users u WHERE u.workspace_id = ? ORDER BY u.id`
    )
    .bind(wsId(ctx)).all();
  return json({ users: results });
}
```

- [ ] **Step 4: `listSubscriptions` 加 payment_count**

把 `listSubscriptions`（約 259-265）的 SQL 改為（在 SELECT 加子查詢）：
```ts
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.display_name AS user_name, pl.name AS plan_name,
            (SELECT COUNT(*) FROM payments p WHERE p.subscription_id = s.id) AS payment_count
     FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE s.workspace_id = ? ORDER BY s.id`
  ).bind(wsId(ctx)).all();
```

- [ ] **Step 5: `listPlans` 加 subscription_count**

把 `listPlans`（約 223-226）改為：
```ts
async function listPlans(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS subscription_count
     FROM plans p WHERE p.workspace_id = ? ORDER BY p.id`
  ).bind(wsId(ctx)).all();
  return json({ plans: results });
}
```

- [ ] **Step 6: `listChannelTags` 加 usage_count**

把 `listChannelTags`（約 306-309）改為：
```ts
async function listChannelTags(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ct.*, (SELECT COUNT(*) FROM payments p WHERE p.verified_channel_tag_id = ct.id OR p.declared_channel_tag_id = ct.id) AS usage_count
     FROM channel_tags ct WHERE ct.workspace_id = ? ORDER BY ct.sort_order, ct.id`
  ).bind(wsId(ctx)).all();
  return json({ channel_tags: results });
}
```

- [ ] **Step 7: 跑測試 + typecheck（含無 .dev.vars）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm --filter @chippot/worker test 2>&1 | grep -E "Test Files|Tests "
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 無錯；全綠、無 failed（175 + 1 → 176）。

- [ ] **Step 8: Commit**
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin): add dependency counts to list endpoints

users gain subscription_count + payment_count; subscriptions gain payment_count;
plans gain subscription_count; channel_tags gain usage_count. Drives the delete
confirmation dialog and the guarded-delete front-end disable."
```

---

## Task 4: 前端刪除鈕 + 確認 Modal

**Files:**
- Modify: `packages/admin/src/api.ts`（4 delete 方法 + 4 interface 計數欄位）
- Modify: `packages/admin/src/views/Manage.tsx`（4 區塊刪除鈕 + 確認）

- [ ] **Step 1: `api.ts` 加 delete 方法 + interface 計數欄位**

在 `packages/admin/src/api.ts`：
(a) interface 加計數欄位（覆寫 4 行）：
```ts
export interface ChannelTag { id: number; name: string; type: string | null; active: number; sort_order: number; usage_count?: number }
export interface Plan { id: number; name: string; provider: string; monthly_amount: number; discord_role_id: string | null; active: number; subscription_count?: number }
export interface User { id: number; display_name: string; discord_id: string | null; email: string | null; note: string | null; subscription_count?: number; payment_count?: number }
export interface Subscription { id: number; user_name: string; plan_name: string; status: string; start_date: string; billing_day: number; custom_cycle: number; user_id: number; plan_id: number; payment_count?: number }
```
(b) 在 `api` 物件內，於對應的 update 方法附近加 4 個 delete 方法：
```ts
  deleteUser: (id: number) => req<{ ok: boolean; deleted: { subscriptions: number; payments: number } }>("DELETE", `/users/${id}`),
  deleteSubscription: (id: number) => req<{ ok: boolean; deleted: { payments: number } }>("DELETE", `/subscriptions/${id}`),
  deletePlan: (id: number) => req("DELETE", `/plans/${id}`),
  deleteChannelTag: (id: number) => req("DELETE", `/channel-tags/${id}`),
```

- [ ] **Step 2: `Manage.tsx` 加共用確認元件**

在 `packages/admin/src/views/Manage.tsx` 的 `useForm` 之後新增一個小確認 Modal 元件：
```tsx
function ConfirmDelete({ title, message, onClose, onConfirm }: { title: string; message: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { await onConfirm(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <p style={{ whiteSpace: "pre-wrap", marginBottom: 16 }}>{message}</p>
      <button className="btn" onClick={onClose} disabled={busy} style={{ marginRight: 8 }}>取消</button>
      <button className="btn btn--danger" onClick={go} disabled={busy}>{busy ? "刪除中…" : "確認刪除"}</button>
    </Modal>
  );
}
```
（若樣式無 `btn--danger`，沿用 `btn btn--primary` 亦可；保持與既有按鈕一致。實作者可用 `btn btn--primary` 並加 `style={{ background: "var(--danger, #c0392b)" }}` 視專案 CSS 而定——優先用既有 class，無 danger 則用 primary。）

- [ ] **Step 3: Users 區塊加刪除（cascade，確認顯示計數）**

在 `Users()` 元件：加 `del` 狀態與刪除鈕、確認框。把 `const [edit, setEdit] = ...` 那行之後加 `const [del, setDel] = useState<User | null>(null);`。把成員列的 action cell：
```tsx
                  <td className="right"><button className="btn" onClick={() => setEdit(u)}>編輯</button></td>
```
改為：
```tsx
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(u)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(u)}>刪除</button>
                  </td>
```
並在 `{edit !== undefined && <UserModal .../>}` 之後加：
```tsx
      {del && (
        <ConfirmDelete
          title={`刪除成員 · ${del.display_name}`}
          message={`將一併刪除此成員的 ${del.subscription_count ?? 0} 個訂閱、${del.payment_count ?? 0} 筆繳費紀錄。\n此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteUser(del.id); setDel(null); reload(); }}
        />
      )}
```

- [ ] **Step 4: Subscriptions 區塊加刪除（cascade，確認顯示 payment_count）**

在 `Subscriptions()`：加 `const [del, setDel] = useState<Subscription | null>(null);`。訂閱列 action cell：
```tsx
                  <td className="right"><button className="btn" onClick={() => setEdit(s)}>編輯</button></td>
```
改為：
```tsx
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(s)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(s)}>刪除</button>
                  </td>
```
在 `{edit && <SubEditModal .../>}` 之後加：
```tsx
      {del && (
        <ConfirmDelete
          title={`刪除訂閱 · ${del.user_name} · ${del.plan_name}`}
          message={`將一併刪除此訂閱的 ${del.payment_count ?? 0} 筆繳費紀錄。\n此操作無法復原。（若只想停收可改用「編輯 → 狀態 cancelled」）`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteSubscription(del.id); setDel(null); reload(); }}
        />
      )}
```

- [ ] **Step 5: Plans 區塊加刪除（guarded：被參照則 disable）**

在 `Plans()`：加 `const [del, setDel] = useState<Plan | null>(null);`。方案列 action cell：
```tsx
                  <td className="right"><button className="btn" onClick={() => setEdit(p)}>編輯</button></td>
```
改為（被訂閱參照時 disable，附 title 提示）：
```tsx
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(p)}>編輯</button>{" "}
                    <button className="btn" disabled={(p.subscription_count ?? 0) > 0} title={(p.subscription_count ?? 0) > 0 ? "使用中，請先刪除訂閱或停用" : ""} onClick={() => setDel(p)}>刪除</button>
                  </td>
```
在 `{edit !== undefined && <PlanModal .../>}` 之後加：
```tsx
      {del && (
        <ConfirmDelete
          title={`刪除方案 · ${del.name}`}
          message={`確定刪除此方案？此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deletePlan(del.id); setDel(null); reload(); }}
        />
      )}
```

- [ ] **Step 6: ChannelTags 區塊加刪除（guarded：被參照則 disable）**

在 `ChannelTags()`：加 `const [del, setDel] = useState<ChannelTag | null>(null);`。渠道列 action cell：
```tsx
                  <td className="right"><button className="btn" onClick={() => setEdit(t)}>編輯</button></td>
```
改為：
```tsx
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(t)}>編輯</button>{" "}
                    <button className="btn" disabled={(t.usage_count ?? 0) > 0} title={(t.usage_count ?? 0) > 0 ? "已被繳費紀錄參照，請改用停用" : ""} onClick={() => setDel(t)}>刪除</button>
                  </td>
```
在 `{edit !== undefined && <TagModal .../>}` 之後加：
```tsx
      {del && (
        <ConfirmDelete
          title={`刪除渠道 · ${del.name}`}
          message={`確定刪除此支付渠道？此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteChannelTag(del.id); setDel(null); reload(); }}
        />
      )}
```

- [ ] **Step 7: typecheck + build**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build 2>&1 | tail -2
```
Expected: 無 TS 錯；`✓ built`。

- [ ] **Step 8: Commit**
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/admin/src/api.ts packages/admin/src/views/Manage.tsx
git commit -m "feat(admin): delete buttons + confirmation for members/subs/plans/tags

Each Manage list row gets a delete action. Members/subscriptions show a cascade
confirmation with affected counts; plans/channel-tags disable delete while still
referenced (guarded). Adds the api delete methods + count fields to the types."
```

---

## Final verification（全部 Task 完成後）

- [ ] **Step 1: 全 monorepo 綠燈（無 .dev.vars = CI 條件）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm -r typecheck && pnpm -r test 2>&1 | grep -E "Test Files|Tests " && VITE_API_BASE=https://example.workers.dev pnpm -r build 2>&1 | grep -cE "built in"
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 全過；worker 全綠無 failed（≈176）；build 計數 2（web+admin）。

---

## Self-Review 對照（spec → task）

- spec §3 user/subscription cascade（payments + upload_tokens + R2，child→parent） → Task 1 ✓
- spec §3 plan/channel_tag guarded（409 if referenced；audit） → Task 2 ✓
- spec §4B list 加計數 → Task 3 ✓
- spec §4A DELETE 路由（Access 保護，回計數/409） → Task 1+2 ✓
- spec §4C 前端刪除鈕 + 確認 Modal + guarded disable → Task 4 ✓
- spec §6 測試（cascade 計數、R2 有/無、guarded 409/放行、audit、list 計數） → Task 1/2/3 測試 ✓
- 型別：`subscription_count`/`payment_count`/`usage_count` 與 delete 方法回傳名稱跨 worker↔admin 一致 ✓
