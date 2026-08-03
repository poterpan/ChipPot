# UX-C 成員回饋迴路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓成員知道自己被退回／被確認、看得懂錯誤訊息、查得到自己的帳單、綁錯名字有出路、三個繳費入口的能力差異事先講清楚，而且每一則新的對外訊息都經過 `claimNotification` 去重。

**Architecture:** 三層。(1) **通知底座**：`notification_logs` 加一欄 `event` 與一個 `nudge` type（SQLite 需重建表，migration 0006），`core/notify.ts` 增加 `releaseNotification` / `releaseReceiptSlots`，讓「同一張帳單的退回與確認是兩個 slot、成員重新送出後 slot 釋放」得以成立。(2) **兩個新的外送流程**：`core/receipt.ts`（審核結果回條，退回必發、確認可設定）與 `core/nudge.ts`（個別／入職催繳，claim 去重、admin 明示才 force）——兩者都只走既有的 `Notifier` 介面與帳單頻道 `@`，不新增 DM 能力。(3) **表面修補**：Discord 端（`/我的帳單`、綁錯名字自助解綁、入口能力誠實文案、一次性網頁連結按鈕）、成員 web（錯誤中文化、金額改用帳單金額、失效頁不再指死路）、後台（個別催繳按鈕、匯入／新增訂閱的通知選項、未綁定人數與篩選）。

**Tech Stack:** Cloudflare Workers + D1（`@cloudflare/vitest-pool-workers` 真實 runtime 測試）、React 18 + Vite（admin / web，無測試框架）、Discord Interactions API（既有 REST client，只有 channel API）。

---

## Global Constraints

這些是每一個 task 的隱含驗收條件，逐項照抄自 issue #45 與本批次的交辦：

- **每一則新的對外訊息都必須走既有的 `claimNotification` 去重**（`packages/worker/src/core/notify.ts`）。同一個 `(type, entity)` slot 絕不允許發第二次；唯一的例外是管理員明確按下的「重發」，它沿用專案既有的 delete-then-claim 模式（`billing.ts:192`、`scheduled.ts:147`），且按鈕在飛行中必須 disabled。
- **TDD，真實 runtime**：所有 worker 變更先寫失敗測試（`packages/worker/test/**`，vitest-pool-workers，非 mock D1）。新測試檔要先確認 fixture id band 未被占用；本批次配發的 band 是 **9800–9899 與 98xxx**（`test/routes/payments-review.test.ts` 內另用 9404 / 9416–9419 / 9440–9449）。9xxx 到 9599、9700/9710、90xxx/93xxx/94xxx、70000+ 已被其他檔案占用。
- **測試全綠**：baseline 300 passed（41 檔）+ 本批次新增。`cd packages/worker && pnpm test`。
- **typecheck 全綠**：`pnpm -r typecheck`。注意 `Notifier` 介面加方法會讓 `test/core/scheduled.test.ts:14` 與 `test/core/billing-initiate.test.ts:14` 的 fake notifier 編譯失敗，必須一起補 stub。
- **admin / web 沒有測試框架，不得引入**：驗收方式＝(a) 一行 grep 結構斷言（改前失敗、改後通過）、(b) `pnpm --filter @chippot/admin typecheck`、(c) `vite build`、(d) `vite dev` 開瀏覽器人工確認（Chrome DevTools MCP 或手動）。`packages/admin/vite.config.ts` 沒有 dev proxy，所以 dev server 上的 API 會 404、出現錯誤橫幅，版面仍會渲染——那正是要看的東西。
- **`wrangler.toml` 一律不動**（本機 skip-worktree，內容是佔位符）。
- **`docs/deploy-state.md` 是本機操作紀錄，不進這個 PR。**
- **Conventional commits**；分支 `ux/45-member-feedback`；PR 內文含 `Closes #45`。
- 使用者可見字串一律 zh-TW；worker 內部／管理端英文錯誤訊息維持現狀（那是批次 D 的範圍），但**成員可見**的字串一律中文化。

## Sequencing（寫進 PR 描述）

- 本批次 **在批次 A（#43）合併之後** 執行。A 決定了「開繳／收回／改價」的狀態機語意，Task 6（兩套金額算法收斂）直接依賴它：開工前先確認 A 的 `initiateBillingOpened` 改價語意與 `reprice` 行為已定案，否則 web 頁會顯示一個 A 還會再改一次的金額。
- 本批次 **與批次 B（#44）平行**，各自 worktree。**B 擁有 `Manage.tsx` 的表格 markup**。因此 Task 15（C9）刻意設計成「不碰 `<table>` 內部結構」的最小插入，並標記為 rebase 敏感：B 先合併就重新 anchor，衝突只會落在 `tbody` 的 `.map()` 那一行。
- 本批次順帶修掉 healthcheck 的 **P0-8**（`/繳費` 指令描述說欄位「可選」）——見 Task 7。批次 D 執行時應跳過該項，不要再改一次。
- Task 6 順帶把成員頁金額補上千分位（批次 D 的 D19 的 web 半邊）。同樣請批次 D 只處理後台那半邊。
- 全部 16 個 task。相依鏈與可平行的部分見文末 Self-Review。

---

## File Structure

**新增**

| 檔案 | 職責 |
|---|---|
| `packages/worker/migrations/0006_notification_event.sql` | 重建 `notification_logs`：加 `event` 欄、`type` 加 `'nudge'`、UNIQUE 含 `event` |
| `packages/worker/src/core/receipt.ts` | 審核結果回條的編排：載入帳單列、逐筆 claim、組一則訊息、失敗時把 slot 還回去 |
| `packages/worker/src/core/nudge.ts` | 個別／入職催繳的編排：開繳閘門、claim 去重、未綁定人數回報 |
| `packages/worker/test/core/notify-slots.test.ts` | slot 原語（claim／release／event 區分／nudge type）— band 9800 |
| `packages/worker/test/core/receipt.test.ts` | 回條核心語意 — band 9810 |
| `packages/worker/test/core/nudge.test.ts` | 催繳核心語意 — band 9820 |
| `packages/worker/test/adapters/discord-receipt.test.ts` | 回條訊息格式（無 D1） |
| `packages/worker/test/adapters/discord-pay-entry.test.ts` | 繳費入口文案與網頁連結按鈕 — band 9830 |
| `packages/worker/test/adapters/discord-mybills.test.ts` | `/我的帳單` — band 9840 |

**修改**

| 檔案 | 改什麼 |
|---|---|
| `packages/worker/src/core/notify.ts` | `NotificationKey.event`、`'nudge'` type、`releaseNotification`、`releaseReceiptSlots`、`Notifier.sendPaymentReceipt`、`sendPaymentNudge` 加 `kind` |
| `packages/worker/src/adapters/discord/notify.ts` | 實作 `sendPaymentReceipt`；`sendPaymentNudge` 依 `kind` 換開頭句 |
| `packages/worker/src/core/billing.ts` | 收回本期開繳時一併清掉該期的 `receipt` / `nudge` slot（並修正 426 行已過時的註解） |
| `packages/worker/src/core/storage.ts` | 成員重新送出成功後釋放該 (member, period) 的 receipt slot |
| `packages/worker/src/routes/admin.ts` | reject / verify / verify-all / unverify 接回條；新增 `POST /admin/notifications/nudge`；sync 的 nudge 改走 `core/nudge.ts`；註冊指令改用 `payCommand(!!env.BUCKET)` 並加入 `/我的帳單` |
| `packages/worker/src/routes/upload.ts` | 成員可見錯誤中文化；`GET` 回傳帳單金額 `lines` 而非方案定價 |
| `packages/worker/src/adapters/discord/handler.ts` | 入口能力誠實文案、網頁連結按鈕、`/我的帳單`、綁錯名字自助解綁 |
| `packages/worker/src/adapters/discord/commands.ts` | `payCommand(proofEnabled)`、`MY_BILLS_COMMAND`、`webLinkButton`、`rebindRow` |
| `packages/worker/src/core/db.ts` | `listRecentPayments`、`unbindDiscordId` |
| `packages/worker/src/env.ts` | `receipt_notify_verified` 設定 |
| `packages/worker/scripts/register-commands.mjs` | 與 `commands.ts` 對齊（含 `綁定` 的 `名字` 選項——目前已漂移） |
| `packages/web/src/{App.tsx,api.ts}` | `lines` 金額來源、已繳狀態、失效頁文案 |
| `packages/admin/src/api.ts` | `nudgeMembers` |
| `packages/admin/src/views/Settings.tsx` | 確認回條開關；匯入後通知選項 |
| `packages/admin/src/views/Payments.tsx` | SyncModal 補「另 M 位未綁定，通知不到」 |
| `packages/admin/src/views/MemberReview.tsx` | 個別催繳按鈕 |
| `packages/admin/src/views/Manage.tsx` | 未綁定計數 pill＋篩選（最小插入）；新增訂閱後可通知 |
| `README.md` / `README.zh-TW.md` / `docs/DEPLOY.md` | 測試數、新功能、migration 範圍 |

---

### Task 1: 通知 slot 底座（migration 0006 + release 原語）

**Files:**
- Create: `packages/worker/migrations/0006_notification_event.sql`
- Create: `packages/worker/test/core/notify-slots.test.ts`
- Modify: `packages/worker/src/core/notify.ts:26-51`
- Modify: `packages/worker/src/core/billing.ts:407-429`（retract 的 batch 與 426 行註解）
- Modify: `packages/worker/test/core/billing-retract.test.ts`（追加 1 個 it）

**Interfaces:**
- Consumes: 既有 `claimNotification(db, k)`。
- Produces:
  - `NotificationKey` 多一個 `event?: string`；`type` union 變成 `"billing_opened" | "overdue" | "receipt" | "nudge"`。
  - `releaseNotification(db: D1Database, k: NotificationKey): Promise<number>` — 精準鍵刪除；`event` 省略＝刪掉該 entity 的所有 event。
  - `releaseReceiptSlots(db: D1Database, workspaceId: number, period: string, userId: number): Promise<number>` — 一位成員一期的所有 receipt slot。

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/core/notify-slots.test.ts`。`notification_logs` 沒有任何 FK，所以這個檔案不需要 seed 任何 workspace／user。

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimNotification, releaseNotification, releaseReceiptSlots } from "../../src/core/notify";

// Fresh id band for this file: workspace 9800. notification_logs has no foreign keys, so no
// parent rows are needed. (Bands up to 9599, 9700/9710, 90xxx/93xxx/94xxx and 70000+ are taken.)
const WS = 9800;
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
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/core/notify-slots.test.ts`
Expected: FAIL —「`releaseNotification` is not exported」型別／執行期錯誤，且 `nudge` 那題會因為 CHECK constraint 失敗。

- [ ] **Step 3: 寫 migration**

建立 `packages/worker/migrations/0006_notification_event.sql`：

```sql
-- Receipt and nudge notifications need two things the original table can't express:
--   * a per-EVENT slot — 退回 and 確認 of the same bill are two different messages, so they
--     must not share one dedup slot;
--   * a 'nudge' type — 個別催繳 is neither 開繳 nor 逾期催繳.
-- SQLite cannot ALTER a CHECK constraint or a table-level UNIQUE, so the table is rebuilt.
-- notification_logs has no foreign keys in either direction, so a plain rebuild is safe.
CREATE TABLE notification_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('billing_opened','overdue','receipt','nudge')),
  period TEXT NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  subscription_id INTEGER NOT NULL DEFAULT 0,
  -- '' = the whole-entity slot (billing_opened / overdue / nudge). Receipts use 'reject' / 'verify'.
  event TEXT NOT NULL DEFAULT '',
  external_channel_type TEXT,
  external_message_id TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id, event)
);

INSERT INTO notification_logs_new
  (id, workspace_id, type, period, plan_id, user_id, subscription_id, event,
   external_channel_type, external_message_id, sent_at)
SELECT id, workspace_id, type, period, plan_id, user_id, subscription_id, '',
       external_channel_type, external_message_id, sent_at
FROM notification_logs;

DROP TABLE notification_logs;
ALTER TABLE notification_logs_new RENAME TO notification_logs;
```

- [ ] **Step 4: 改 `core/notify.ts`**

`packages/worker/src/core/notify.ts:26-51` 整段換成：

```ts
export interface NotificationKey {
  workspaceId: number;
  type: "billing_opened" | "overdue" | "receipt" | "nudge";
  period: string;
  planId?: number;
  userId?: number;
  subscriptionId?: number;
  /**
   * Distinguishes two messages that share one entity. A bill's 退回 and 確認 are different
   * events on the same (period, user, subscription), so they must not share a slot.
   * Omitted = '' = the entity-wide slot used by billing_opened / overdue / nudge.
   */
  event?: string;
}

/**
 * Claim a notification slot to guarantee at-most-once sending. Inserts a notification_logs
 * row; returns true if this caller won the slot (should send), false if already sent.
 * Uses NOT NULL DEFAULT 0 / '' sentinels so the UNIQUE actually dedupes (roadmap §4.1).
 */
export async function claimNotification(db: D1Database, k: NotificationKey): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO notification_logs
        (workspace_id, type, period, plan_id, user_id, subscription_id, event, external_channel_type, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'discord', ?)
       ON CONFLICT(workspace_id, type, period, plan_id, user_id, subscription_id, event) DO NOTHING`
    )
    .bind(k.workspaceId, k.type, k.period, k.planId ?? 0, k.userId ?? 0, k.subscriptionId ?? 0, k.event ?? "", nowUtcIso())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Give a claimed slot back so a genuinely new event can announce again. Used for two things:
 * an outbound send that failed (never mute a bill forever because Discord hiccuped) and the
 * admin's explicit "重發" (delete-then-claim, same pattern as billing.ts / scheduled.ts).
 * Omitting `event` releases every event of that entity. Returns the number of rows deleted.
 */
export async function releaseNotification(db: D1Database, k: NotificationKey): Promise<number> {
  const conds = ["workspace_id = ?", "type = ?", "period = ?", "plan_id = ?", "user_id = ?", "subscription_id = ?"];
  const binds: unknown[] = [k.workspaceId, k.type, k.period, k.planId ?? 0, k.userId ?? 0, k.subscriptionId ?? 0];
  if (k.event !== undefined) { conds.push("event = ?"); binds.push(k.event); }
  const res = await db.prepare(`DELETE FROM notification_logs WHERE ${conds.join(" AND ")}`).bind(...binds).run();
  return res.meta.changes ?? 0;
}

/**
 * Drop every receipt slot of ONE member's period. Called when the ball moves back to the member
 * (they re-submitted after a 退回) or when an admin undoes a verification: the next 退回/確認 of
 * those bills is then a new fact, not a retry, and must be announced again.
 */
export async function releaseReceiptSlots(
  db: D1Database, workspaceId: number, period: string, userId: number
): Promise<number> {
  const res = await db
    .prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'receipt' AND period = ? AND user_id = ?")
    .bind(workspaceId, period, userId)
    .run();
  return res.meta.changes ?? 0;
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && pnpm test test/core/notify-slots.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 6: 收回本期開繳時一併清 receipt / nudge slot**

`packages/worker/src/core/billing.ts`：把 422-428 行那段註解與 statement 換成下面內容（**新 statement 加在 batch 尾端**，`res[1]` / `res[2]` 的索引不能變）：

```ts
    // The overdue slot is claimed once per (workspace, period) and never expires, so leaving it
    // behind would permanently mute overdue reminders if this period is ever re-opened —
    // claimNotification would lose and sendOverdueForPeriod would just return 0, with no error
    // anywhere. Kept as its own statement so it cannot inflate the marker's changes count.
    env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period),
    // Same reasoning for the member-facing slots: a retracted period's 回條 (receipt) and 個別催繳
    // (nudge) claims refer to bills that no longer exist. Appended last so the indices read back
    // above stay put.
    env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type IN ('receipt','nudge') AND period = ?")
      .bind(workspaceId, period),
```

- [ ] **Step 7: 幫 retract 補測試**

在 `packages/worker/test/core/billing-retract.test.ts` 最後一個 `it` 之後追加（沿用該檔既有的 `WS` / `P` / `retractPeriodBilling` import）：

```ts
  it("clears the period's receipt and nudge slots so a re-open can announce again", async () => {
    const P2 = "2031-09";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P2, 0, 0, 0, "", TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "receipt", P2, 0, 97001, 97001, "reject", TS),
      env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "nudge", P2, 0, 97001, 0, "", TS),
    ]);
    await retractPeriodBilling(env, WS, P2, { dryRun: false });
    const left = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND period=?")
      .bind(WS, P2).first<{ c: number }>();
    expect(left!.c).toBe(0);
  });
```

- [ ] **Step 8: 跑全套測試**

Run: `cd packages/worker && pnpm test`
Expected: 300 baseline + 8 新增 = 308 passed，0 failed。若 `test/schema.test.ts` 有針對 UNIQUE sentinel 的斷言失敗，檢查它是否需要一併帶 `event` 欄（`schema.test.ts:70`）。

- [ ] **Step 9: typecheck**

Run: `pnpm -r typecheck`
Expected: 無輸出，exit 0。

- [ ] **Step 10: Commit**

```bash
git add packages/worker/migrations/0006_notification_event.sql packages/worker/src/core/notify.ts packages/worker/src/core/billing.ts packages/worker/test/core/notify-slots.test.ts packages/worker/test/core/billing-retract.test.ts
git commit -m "feat(notify): notification_logs 加 event 欄與 nudge type，補上 release 原語

同一張帳單的退回與確認需要兩個 dedup slot，個別催繳需要自己的 type。
SQLite 無法 ALTER CHECK/UNIQUE，故以 0006 重建表。收回本期開繳時一併清掉
該期的 receipt/nudge slot。"
```

---

### Task 2: Discord 回條訊息（adapter）

**Files:**
- Modify: `packages/worker/src/core/notify.ts`（`Notifier` 介面 + 回條型別）
- Modify: `packages/worker/src/adapters/discord/notify.ts`
- Modify: `packages/worker/test/core/scheduled.test.ts:14-18`、`packages/worker/test/core/billing-initiate.test.ts:14-18`（fake notifier 補 stub）
- Create: `packages/worker/test/adapters/discord-receipt.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `notify.ts`；既有 `createChannelMessage`、`payButtonRow`。
- Produces:
  - `export type ReceiptKind = "reject" | "verify";`
  - `export interface ReceiptLine { plan_name: string; amount: number }`
  - `export interface ReceiptTarget { user_id: number; discord_id: string | null; user_name: string; period: string; lines: ReceiptLine[]; total: number }`
  - `Notifier.sendPaymentReceipt(env, channelId: string, workspaceId: number, kind: ReceiptKind, target: ReceiptTarget, reason: string | null): Promise<void>`

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/adapters/discord-receipt.test.ts`（純單元，不碰 D1，沿用 `discord-nudge.test.ts` 的 captureFetch 手法）：

```ts
import { describe, expect, it, vi } from "vitest";
import { discordNotifier } from "../../src/adapters/discord/notify";
import type { ReceiptTarget } from "../../src/core/notify";

const env = { DISCORD_BOT_TOKEN: "tok" } as any;

const target = (discord_id: string | null): ReceiptTarget => ({
  user_id: 1, discord_id, user_name: "王小明", period: "2029-03",
  lines: [{ plan_name: "ChatGPT", amount: 315 }, { plan_name: "Claude Premium", amount: 1258 }],
  total: 1573,
});

function capture() {
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response("{}", { status: 200 });
  }));
  return sent;
}

describe("sendPaymentReceipt", () => {
  it("reject: @s the member, states the reason, lists the bills and offers the pay button", async () => {
    const sent = capture();
    await discordNotifier.sendPaymentReceipt(env, "chan-1", 7, "reject", target("d1"), "金額不符，少 NT$100");
    vi.unstubAllGlobals();
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
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/adapters/discord-receipt.test.ts`
Expected: FAIL —「discordNotifier.sendPaymentReceipt is not a function」。

- [ ] **Step 3: 加型別與介面**

`packages/worker/src/core/notify.ts`，在 `OverduePerson` 之後、`Notifier` 之前插入：

```ts
export type ReceiptKind = "reject" | "verify";
export interface ReceiptLine {
  plan_name: string;
  amount: number;
}
/** One member's one period — a receipt always answers "你這期那幾筆怎麼了". */
export interface ReceiptTarget {
  user_id: number;
  discord_id: string | null;
  user_name: string;
  period: string;
  lines: ReceiptLine[];
  total: number;
}
```

並在 `Notifier` 介面尾端加一個方法：

```ts
  /**
   * 審核結果回條: tell the member their submission was 退回 (with the reason) or 確認. Delivered in
   * the billing channel with an @-mention — the Discord adapter has no DM capability, and every
   * other member-facing message in this system already lands there.
   */
  sendPaymentReceipt(
    env: Env, channelId: string, workspaceId: number, kind: ReceiptKind,
    target: ReceiptTarget, reason: string | null
  ): Promise<void>;
```

- [ ] **Step 4: 實作 Discord adapter**

`packages/worker/src/adapters/discord/notify.ts`：import 多帶 `ReceiptKind`、`ReceiptTarget`，並在 `sendPaymentNudge` 之後加：

```ts
  async sendPaymentReceipt(env: Env, channelId, workspaceId: number, kind, target: ReceiptTarget, reason) {
    const who = target.discord_id ? `<@${target.discord_id}>` : `**${target.user_name}**`;
    const lines = target.lines.map((l) => `・${l.plan_name} NT$${l.amount.toLocaleString()}`).join("\n");
    const body = `${lines}\n**合計 NT$${target.total.toLocaleString()}**`;
    const content = kind === "reject"
      ? `↩️ ${who} 你的 ${target.period} 繳費被退回\n${body}\n退回原因：${reason?.trim() || "（管理員未填寫原因，請在頻道詢問）"}\n請確認後點下方「繳費」按鈕重新登記，或用 \`/繳費\` 補上截圖／備註。`
      : `✅ ${who} 已確認收到你的 ${target.period} 繳費\n${body}`;
    // Pin the mention to exactly this member's id — nothing in the reason text can be coerced
    // into a ping (the reason is admin-authored free text).
    const users = target.discord_id ? [target.discord_id] : [];
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      // 退回 puts the ball back in the member's court, so give them the way back in one tap.
      ...(kind === "reject" ? { components: [payButtonRow(workspaceId)] } : {}),
      allowed_mentions: { parse: [], users },
    });
  },
```

- [ ] **Step 5: 補兩個 fake notifier 的 stub**

`packages/worker/test/core/scheduled.test.ts:14-18` 與 `packages/worker/test/core/billing-initiate.test.ts:14-18` 的 `const notifier: Notifier = { … }`，各加一行：

```ts
  async sendPaymentReceipt() {},
```

- [ ] **Step 6: 跑測試 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 308 + 4 = 312 passed；typecheck 無輸出。

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/core/notify.ts packages/worker/src/adapters/discord/notify.ts packages/worker/test/adapters/discord-receipt.test.ts packages/worker/test/core/scheduled.test.ts packages/worker/test/core/billing-initiate.test.ts
git commit -m "feat(discord): 審核結果回條訊息（退回帶原因＋繳費按鈕、確認為純告知）

投遞走帳單頻道 @：adapter 只有 channel API，且既有的開繳／催繳／入職提醒
都在同一個頻道，成員的目光已經在那裡。未綁定者退回粗體姓名、不 ping。"
```

---

### Task 3: 退回必發回條（core/receipt.ts + reject 路由 + slot 釋放）

**Files:**
- Create: `packages/worker/src/core/receipt.ts`
- Create: `packages/worker/test/core/receipt.test.ts`
- Modify: `packages/worker/src/routes/admin.ts:673-686`（reject）、`:701-713`（unverify）
- Modify: `packages/worker/src/core/storage.ts:237-245`（settle 成功後釋放）
- Modify: `packages/worker/test/routes/payments-review.test.ts`（追加路由層 it）

**Interfaces:**
- Consumes: Task 1 的 `claimNotification` / `releaseNotification` / `releaseReceiptSlots`；Task 2 的 `Notifier.sendPaymentReceipt`。
- Produces:
  - `export interface ReceiptRequest { workspaceId: number; kind: ReceiptKind; paymentIds: number[]; reason?: string | null }`
  - `export async function announcePaymentReceipt(env: Env, req: ReceiptRequest, notifier: Notifier): Promise<number>` — 回傳「這次真的公告出去的帳單筆數」，0 代表沒東西可講／沒有投遞管道／slot 已被占用。

- [ ] **Step 1: 寫失敗測試（核心語意）**

建立 `packages/worker/test/core/receipt.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { announcePaymentReceipt } from "../../src/core/receipt";
import { claimNotification, type Notifier, type ReceiptTarget } from "../../src/core/notify";
import { settleUserPeriod } from "../../src/core/storage";

// Fresh id band for this file: workspace/plan 9810, users 9810x, subs 98110-98111, payments 98120-98121.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9810;
const CHAN = "chan-9810";
const USER = 98101;
const SUB_A = 98110, SUB_B = 98111;
const PAY_A = 98120, PAY_B = 98121;
const P = "2029-04";

const sent: { kind: string; target: ReceiptTarget; reason: string | null }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() {},
  async sendOverdue() {},
  async sendPaymentNudge() {},
  async sendPaymentReceipt(_e, _ch, _ws, kind, target, reason) { sent.push({ kind, target, reason }); },
};
const failing: Notifier = { ...notifier, async sendPaymentReceipt() { throw new Error("discord 502"); } };

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, "d-9810", "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER, WS, "2029-04-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER, WS, "2029-04-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_A, WS, SUB_A, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(PAY_B, WS, SUB_B, P, `${P}-01`, `${P}-30`, `${P}-05`, 251, "cron", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P, 0, 0, 0, "", TS),
  ]);
});

describe("announcePaymentReceipt", () => {
  it("announces a rejection once and claims that bill's reject slot", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "金額不符" }, notifier)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.lines).toEqual([{ plan_name: "ChatGPT", amount: 315 }]);
    expect(sent[0]!.reason).toBe("金額不符");
    expect(await claimNotification(env.DB, { workspaceId: WS, type: "receipt", period: P, userId: USER, subscriptionId: SUB_A, event: "reject" })).toBe(false);
  });

  it("does not announce the same rejection twice", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "金額不符" }, notifier)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("announces the verify of the same bill (a different event, a different slot)", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "verify", paymentIds: [PAY_A], reason: null }, notifier)).toBe(1);
    expect(sent[0]!.kind).toBe("verify");
  });

  it("aggregates several bills of one member into ONE message", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "verify", paymentIds: [PAY_A, PAY_B], reason: null }, notifier)).toBe(1);
    // PAY_A's verify slot was taken by the previous test, so only PAY_B is left to announce.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.lines).toHaveLength(1);
    expect(sent[0]!.target.total).toBe(251);
  });

  it("re-announces a rejection after the member re-submits", async () => {
    // The member settles the period: both bills go pending/rejected -> paid, releasing the slots.
    await settleUserPeriod(env, { workspaceId: WS, userId: USER, period: P, source: "user_slash", paymentNote: "重送" });
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS, kind: "reject", paymentIds: [PAY_A], reason: "還是不對" }, notifier)).toBe(1);
    expect(sent[0]!.reason).toBe("還是不對");
  });

  it("gives the slot back when the send fails, so a later attempt still announces", async () => {
    const other = { workspaceId: WS, kind: "verify" as const, paymentIds: [PAY_B], reason: null };
    sent.length = 0;
    expect(await announcePaymentReceipt(env, other, failing)).toBe(0);
    expect(await announcePaymentReceipt(env, other, notifier)).toBe(1);
  });

  it("does not burn a slot when there is nowhere to send", async () => {
    const noChannel = 9819;
    await env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(noChannel, "W2", "o", "discord", 5, "{}", TS, TS).run();
    expect(await announcePaymentReceipt(env, { workspaceId: noChannel, kind: "reject", paymentIds: [PAY_A] }, notifier)).toBe(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id = ?").bind(noChannel).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/core/receipt.test.ts`
Expected: FAIL — 找不到模組 `../../src/core/receipt`。

- [ ] **Step 3: 實作 `core/receipt.ts`**

```ts
import type { Env } from "../env";
import { parseSettings } from "../env";
import {
  claimNotification, releaseNotification,
  type Notifier, type ReceiptKind, type ReceiptTarget,
} from "./notify";

export interface ReceiptRequest {
  workspaceId: number;
  kind: ReceiptKind;
  /** Bills to announce. Callers pass one member's rows: a 退回 is one bill, 一鍵全部核准 is one
   *  member × one period. Anything outside the first row's (user, period) is dropped. */
  paymentIds: number[];
  reason?: string | null;
}

interface ReceiptRow {
  payment_id: number; subscription_id: number; period: string; amount: number;
  user_id: number; user_name: string; discord_id: string | null; plan_name: string;
}

/**
 * 審核結果回條 (P0-5): announce a 退回 / 確認 back to the member in the billing channel.
 *
 * Dedup is per (payment, event): 退回 and 確認 of one bill are two slots, and both are released
 * when the member re-submits (storage.settleUserPeriod) or an admin undoes a verification, so a
 * genuine second 退回 announces again while a retry never does. Returns the number of bills this
 * call actually announced (0 = nothing new to say, or nowhere to send).
 */
export async function announcePaymentReceipt(
  env: Env,
  req: ReceiptRequest,
  notifier: Notifier
): Promise<number> {
  if (req.paymentIds.length === 0) return 0;
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
    .bind(req.workspaceId).first<{ settings: string }>();
  if (!wsRow) return 0;
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  // Same rule as the cron (scheduled.ts:36-38): with no channel or no bot token we cannot send,
  // so we must not consume the dedup slot — otherwise configuring Discord later would arrive to
  // a bill that already counts as announced.
  if (!channelId || !env.DISCORD_BOT_TOKEN) return 0;

  const marks = req.paymentIds.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.period AS period, p.amount AS amount,
            s.user_id AS user_id, u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.id IN (${marks})
     ORDER BY p.id`
  ).bind(req.workspaceId, ...req.paymentIds).all<ReceiptRow>()).results;
  if (rows.length === 0) return 0;

  const head = rows[0]!;
  const mine = rows.filter((r) => r.user_id === head.user_id && r.period === head.period);

  // Claim per bill, send once: 一鍵全部核准 verifies N rows and must produce ONE message, not N.
  const claimed: ReceiptRow[] = [];
  for (const r of mine) {
    const won = await claimNotification(env.DB, {
      workspaceId: req.workspaceId, type: "receipt", period: r.period,
      userId: r.user_id, subscriptionId: r.subscription_id, event: req.kind,
    });
    if (won) claimed.push(r);
  }
  if (claimed.length === 0) return 0;

  const target: ReceiptTarget = {
    user_id: head.user_id, discord_id: head.discord_id, user_name: head.user_name, period: head.period,
    lines: claimed.map((r) => ({ plan_name: r.plan_name, amount: r.amount })),
    total: claimed.reduce((s, r) => s + r.amount, 0),
  };

  try {
    await notifier.sendPaymentReceipt(env, channelId, req.workspaceId, req.kind, target, req.reason ?? null);
  } catch (err) {
    // Hand the slots back: a Discord hiccup must not mute this bill's receipt forever. The admin
    // action itself already committed, so failing the request would be worse than a silent retry.
    console.error("receipt send failed", err);
    for (const r of claimed) {
      await releaseNotification(env.DB, {
        workspaceId: req.workspaceId, type: "receipt", period: r.period,
        userId: r.user_id, subscriptionId: r.subscription_id, event: req.kind,
      }).catch(() => 0);
    }
    return 0;
  }
  return claimed.length;
}
```

- [ ] **Step 4: 成員重新送出時釋放 slot**

`packages/worker/src/core/storage.ts`：import 加 `releaseReceiptSlots`（來自 `./notify`），並在 `settleUserPeriod` 的 `if (paidCount > 0) { … }` 區塊開頭插入一行：

```ts
  if (paidCount > 0) {
    // The ball is back with the admin: any 退回/確認 slot from the previous round is stale, so the
    // next review of these bills is a new fact and must be announced (core/receipt.ts).
    await releaseReceiptSlots(env.DB, workspaceId, period, userId);
    const u = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?")
```

- [ ] **Step 5: 接上 reject 路由**

`packages/worker/src/routes/admin.ts`：import 補 `import { announcePaymentReceipt } from "../core/receipt";`，`rejectPaymentHandler` 換成：

```ts
async function rejectPaymentHandler(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const id = Number(ctx.params.id);
  const before = await getPayment(env.DB, id);
  if (!before || before.workspace_id !== wsId(ctx)) return errorResponse(404, "not found");
  const b = await readJson<{ rejected_reason?: string }>(req) ?? {};
  try {
    const after = await rejectPayment(env.DB, id, { rejectedReason: b.rejected_reason ?? null, verifiedBy: actorOf(ctx) });
    await writeAudit(env.DB, { workspaceId: before.workspace_id, actor: actorOf(ctx), action: "payment.reject", entityType: "payment", entityId: id, before, after });
    // 退回一定要回到成員手上 (P0-5). The rejection is already committed; a Discord failure must not
    // turn it into a 500, so announce defensively and report the truth in `notified`.
    const notified = await announcePaymentReceipt(
      env, { workspaceId: before.workspace_id, kind: "reject", paymentIds: [id], reason: b.rejected_reason ?? null }, discordNotifier
    ).catch((e) => { console.error("reject receipt failed", e); return 0; });
    return json({ ok: true, payment: after, notified });
  } catch (e) {
    if (e instanceof InvalidPaymentTransition) return errorResponse(409, e.message);
    throw e;
  }
}
```

- [ ] **Step 6: 撤回驗證時釋放 slot**

同檔 `unverifyPaymentHandler`，在 `writeAudit` 之後加：

```ts
    // 撤回驗證 puts the bill back to 待繳: a later 確認/退回 is a new fact, not a retry.
    const owner = await env.DB.prepare("SELECT user_id FROM subscriptions WHERE id = ?")
      .bind(before.subscription_id).first<{ user_id: number }>();
    if (owner) await releaseReceiptSlots(env.DB, before.workspace_id, before.period, owner.user_id);
```

（`releaseReceiptSlots` 從 `../core/notify` import。）

- [ ] **Step 7: 跑核心測試**

Run: `cd packages/worker && pnpm test test/core/receipt.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 8: 路由層測試**

在 `packages/worker/test/routes/payments-review.test.ts` 的 `beforeAll` 批次尾端追加 fixture（沿用 ws 1；本 task 取用未被占用的 9404 / 9416 / 9440）：

```ts
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(9404, WS, "d-9404", "回條測試員", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(9416, WS, 9404, 1, "2028-07-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(9440, WS, 9416, "2028-07", "2028-07-01", "2028-07-31", "2028-07-05", 315, "paid", "user_slash", TS, TS),
```

並在檔尾追加：

```ts
describe("reject receipt", () => {
  it("announces the rejection with its reason and reports it in the response", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-receipt" } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return new Response("{}", { status: 200 });
    }));
    const res = await call("POST", "/admin/payments/9440/reject", { rejected_reason: "轉帳末五碼對不上" });
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;

    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).notified).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain("<@d-9404>");
    expect(sent[0].content).toContain("轉帳末五碼對不上");
  });
});
```

（該檔頂端的 import 需補 `vi`：`import { beforeAll, describe, expect, it, vi } from "vitest";`）

- [ ] **Step 9: 跑全套 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 312 + 8 = 320 passed。若 `test/core/settle.test.ts` 或 `test/routes/upload.test.ts` 因為 settle 多了一次 DELETE 而失敗，檢查它們是否斷言了 statement 數量（目前沒有；有的話改成斷言結果而非次數）。

- [ ] **Step 10: Commit**

```bash
git add packages/worker/src/core/receipt.ts packages/worker/src/core/storage.ts packages/worker/src/routes/admin.ts packages/worker/test/core/receipt.test.ts packages/worker/test/routes/payments-review.test.ts
git commit -m "feat(receipt): 退回一定通知當事人並附原因（P0-5 的必要半邊）

per (payment, event) claim：退回與確認是兩個 slot；成員重新送出或管理員撤回
驗證時釋放，所以真正的再次退回會再通知、重試不會。送出失敗把 slot 還回去。"
```

---

### Task 4: 確認回條（可設定，預設關）＋ 一鍵全部核准只發一則

**Files:**
- Modify: `packages/worker/src/env.ts:18-92`
- Modify: `packages/worker/src/core/receipt.ts`（verify 的設定閘門）
- Modify: `packages/worker/src/routes/admin.ts:592-610`（verify）、`:628-671`（verify-all）
- Modify: `packages/worker/test/core/receipt.test.ts`（追加設定閘門測試）
- Modify: `packages/worker/test/routes/payments-review.test.ts`（追加 verify-all 只一則）
- Modify: `packages/admin/src/views/Settings.tsx`（開關）

**Interfaces:**
- Consumes: Task 3 的 `announcePaymentReceipt`。
- Produces: `WorkspaceSettings.receipt_notify_verified: boolean`（預設 `false`）；`Form.receipt_notify_verified: string`（`"1"` / `""`）。

- [ ] **Step 1: 寫失敗測試**

`packages/worker/test/core/receipt.test.ts` 追加一個 describe（放在檔尾）：

```ts
describe("verify receipts are opt-in", () => {
  const WS_OFF = 9818;
  const CHAN_OFF = "chan-9818";
  const U_OFF = 98181, S_OFF = 98182, P_OFF = 98183;

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS_OFF, "W", "o", "discord", 5, JSON.stringify({ discord_billing_channel_id: CHAN_OFF }), TS, TS),
      env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OFF, WS_OFF, "d-9818", "李小華", TS, TS),
      env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS_OFF, WS_OFF, "ChatGPT", "openai", 315, TS, TS),
      env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_OFF, WS_OFF, U_OFF, WS_OFF, "2029-04-01", 5, "active", TS, TS),
      env.DB.prepare(`INSERT INTO payments (id,workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(P_OFF, WS_OFF, S_OFF, P, `${P}-01`, `${P}-30`, `${P}-05`, 315, "paid", "user_slash", TS, TS),
    ]);
  });

  it("stays silent on verify when receipt_notify_verified is off (the default)", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "verify", paymentIds: [P_OFF] }, notifier)).toBe(0);
    expect(sent).toHaveLength(0);
    // The slot must stay free: turning the setting on later has to be able to announce.
    expect(await claimNotification(env.DB, { workspaceId: WS_OFF, type: "receipt", period: P, userId: U_OFF, subscriptionId: S_OFF, event: "verify" })).toBe(true);
  });

  it("still announces a rejection when verify receipts are off", async () => {
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "reject", paymentIds: [P_OFF], reason: "重複" }, notifier)).toBe(1);
  });

  it("announces the verify once the workspace turns it on", async () => {
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ discord_billing_channel_id: CHAN_OFF, receipt_notify_verified: true }), WS_OFF).run();
    sent.length = 0;
    expect(await announcePaymentReceipt(env, { workspaceId: WS_OFF, kind: "verify", paymentIds: [P_OFF] }, notifier)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/core/receipt.test.ts`
Expected: FAIL — 第一題會發出訊息（目前 verify 無閘門）。

- [ ] **Step 3: 加設定**

`packages/worker/src/env.ts`：`WorkspaceSettings` 加一欄、`DEFAULT_SETTINGS` 加預設、新增 `bool` helper、`parseSettings` 加一行。

```ts
  payment_notify_template: string; // message body; empty = the built-in default
  /** Also tell the member when their payment is 確認 (退回 always notifies; this one is opt-in
   *  because a channel gets noisy fast when every verified bill posts). */
  receipt_notify_verified: boolean;
```

```ts
  payment_notify_template: "",
  receipt_notify_verified: false,
```

```ts
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
```

```ts
    payment_notify_template: str(raw.payment_notify_template, ""),
    receipt_notify_verified: bool(raw.receipt_notify_verified, false),
```

- [ ] **Step 4: 在 receipt.ts 加閘門**

`packages/worker/src/core/receipt.ts`，緊接 `if (!channelId || !env.DISCORD_BOT_TOKEN) return 0;` 之後：

```ts
  // 退回 is mandatory (the member cannot act without it); 確認 is a courtesy the owner opts into.
  // Return before claiming so switching the setting on later can still announce.
  if (req.kind === "verify" && !settings.receipt_notify_verified) return 0;
```

- [ ] **Step 5: 接上 verify 與 verify-all**

`packages/worker/src/routes/admin.ts`，`verifyPaymentHandler` 的 `writeAudit` 之後：

```ts
    const notified = await announcePaymentReceipt(
      env, { workspaceId: before.workspace_id, kind: "verify", paymentIds: [id] }, discordNotifier
    ).catch((e) => { console.error("verify receipt failed", e); return 0; });
    return json({ ok: true, payment: after, notified });
```

`verifyAllHandler` 的 `await writeSummary();` 之後、`return json(...)` 之前：

```ts
  // ONE receipt for the whole sweep: announcePaymentReceipt claims each bill but sends a single
  // message, so a member with three plans is thanked once, not three times.
  const notified = await announcePaymentReceipt(
    env, { workspaceId: ws, kind: "verify", paymentIds }, discordNotifier
  ).catch((e) => { console.error("verify_all receipt failed", e); return 0; });
  return json({ ok: true, verified: paymentIds.length, payment_ids: paymentIds, notified });
```

- [ ] **Step 6: 路由層測試（verify-all 只一則）**

`packages/worker/test/routes/payments-review.test.ts` 檔尾追加：

```ts
describe("verify-all receipt", () => {
  it("sends exactly one message for a member's whole period", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-receipt", receipt_notify_verified: true } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return new Response("{}", { status: 200 });
    }));
    const res = await call("POST", "/admin/payments/verify-all", { user_id: U_A, period: PERIOD });
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;

    const body = (await res!.json()) as any;
    expect(body.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain("已確認收到");
  });
});
```

> 注意：這題必須排在該檔既有的 verify-all 測試**之後**（同檔內的寫入會累積），若既有測試已把 `U_A` 的 `PERIOD` 全部驗證完，改用 `U_B`／`P_B1` 這組尚未被 sweep 的資料。跑起來看實際狀態再決定。

- [ ] **Step 7: 後台開關**

`packages/admin/src/views/Settings.tsx`：
1. `interface Form` 加 `receipt_notify_verified: string;`，`EMPTY` 加 `receipt_notify_verified: "",`。
2. `useEffect` 的 `const f: Form = {…}` 加 `receipt_notify_verified: s.receipt_notify_verified ? "1" : "",`。
3. `save()` 的 `settings` 物件加 `receipt_notify_verified: form.receipt_notify_verified === "1",`。
4. 在「繳費通知」Card 的 `</div>`（`card__body` 收尾）之前插入：

```tsx
          <label className="field" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={form.receipt_notify_verified === "1"}
              onChange={(e) => set("receipt_notify_verified")(e.target.checked ? "1" : "")}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <span className="field__label">確認收款後也通知成員</span>
              <span className="field__hint">退回一定會在帳單頻道 @ 當事人並附原因；勾選這項後，確認收款也會發一則。人多時頻道會變吵，預設不開。</span>
            </span>
          </label>
```

- [ ] **Step 8: 驗收前端**

```bash
grep -n "receipt_notify_verified" packages/admin/src/views/Settings.tsx | wc -l   # 期望 >= 4
pnpm --filter @chippot/admin typecheck
pnpm --filter @chippot/admin build
```
Expected: grep ≥ 4、typecheck 無輸出、`✓ built in …`。

- [ ] **Step 9: 跑全套 + typecheck**

Run: `cd packages/worker && pnpm test && cd ../.. && pnpm -r typecheck`
Expected: 320 + 4 = 324 passed。

- [ ] **Step 10: Commit**

```bash
git add packages/worker/src/env.ts packages/worker/src/core/receipt.ts packages/worker/src/routes/admin.ts packages/worker/test/core/receipt.test.ts packages/worker/test/routes/payments-review.test.ts packages/admin/src/views/Settings.tsx
git commit -m "feat(receipt): 確認收款回條（可設定，預設關）＋一鍵全部核准只發一則

verify 的閘門放在 claim 之前，之後把設定打開仍能通知。批次核准逐筆 claim、
只送一則訊息，三個方案的成員不會被感謝三次。"
```

---

### Task 5: 成員繳費頁不再吐英文技術錯誤（P0-6）

**Files:**
- Modify: `packages/worker/src/core/storage.ts:22-51`（`InvalidImage` 加 `reason`）
- Modify: `packages/worker/src/routes/upload.ts`（全部成員可見字串中文化）
- Modify: `packages/worker/test/routes/upload.test.ts`（追加字串斷言）

**決策：在 worker 端中文化，不在 `web/api.ts` 做 code→字串對照表。** 理由：`upload.ts:57` 已經有一句中文（`請至少附上截圖、填寫備註，或選擇渠道`），所以這個檔案本來就不是「刻意英文」的內部路由，而是中英夾雜；把字串留在 worker 只有一份來源，任何 client（含未來的 Discord 深連結）都拿到同一句話。`code` 欄位保留給程式判斷，`web/api.ts:58` 的 `錯誤 ${res.status}` 只在後端沒給 `error` 時才會出現。Discord 端已有的中文句子（`handler.ts:198` 截圖格式）維持不動，兩邊語意一致但措辭各自貼合入口。

**Interfaces:**
- Produces: `InvalidImage.reason: "type" | "size"`，讓呼叫端可以自己決定文案（Discord 已有自己的句子）。

- [ ] **Step 1: 寫失敗測試**

`packages/worker/test/routes/upload.test.ts`，在 `describe("upload submit")` 內追加：

```ts
  it("answers a non-image with a zh-TW message, not a technical string", async () => {
    const txt = new File(["hi"], "n.txt", { type: "text/plain" });
    const res = await handleUpload(uploadReq(RAW_OK, { screenshot: txt }), env, ctxFor(RAW_OK));
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.code).toBe("image");
    expect(body.error).toBe("只接受 PNG／JPG／WebP 圖片，請換一張截圖。");
  });

  it("answers an expired link in zh-TW", async () => {
    const res = await handleUpload(uploadReq("deadbeef", {}), env, ctxFor("deadbeef"));
    const body = (await res.json()) as any;
    expect(res.status).toBe(410);
    expect(body.error).toBe("這個連結已失效或已經使用過，請向管理員索取新的連結。");
  });

  it("answers an empty submission in zh-TW", async () => {
    const res = await handleUpload(uploadReq(RAW_OK, {}), env, ctxFor(RAW_OK));
    expect(((await res.json()) as any).error).toBe("請至少附上截圖、填寫備註，或選擇渠道。");
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/routes/upload.test.ts`
Expected: FAIL — 收到 `unsupported content type: text/plain` / `link is no longer valid`。

- [ ] **Step 3: 讓 `InvalidImage` 帶原因**

`packages/worker/src/core/storage.ts:22-27` 與兩處 throw：

```ts
export type InvalidImageReason = "type" | "size";
export class InvalidImage extends Error {
  constructor(message: string, public readonly reason: InvalidImageReason = "type") {
    super(message);
    this.name = "InvalidImage";
  }
}
```

```ts
    default: throw new InvalidImage(`unsupported content type: ${contentType}`, "type");
```

```ts
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new InvalidImage(`unsupported content type: ${contentType}`, "type");
  }
  const max = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!(sizeBytes > 0) || sizeBytes > max) {
    throw new InvalidImage(`size out of range: ${sizeBytes}`, "size");
  }
```

- [ ] **Step 4: 中文化 `routes/upload.ts`**

在 import 之後加一個小對照，並把六處字串換掉：

```ts
// Member-facing copy lives here, not in the SPA: this route is the only thing that knows WHY it
// said no, and any client (the upload page today, a Discord deep link tomorrow) needs the same
// sentence. The `code` field stays for programmatic handling.
const IMAGE_ERROR: Record<string, string> = {
  type: "只接受 PNG／JPG／WebP 圖片，請換一張截圖。",
  size: "截圖檔案太大（上限 10 MB），請壓縮後再試。",
};
const imageError = (e: InvalidImage) => IMAGE_ERROR[e.reason] ?? IMAGE_ERROR.type!;
```

| 位置 | 原字串 | 新字串 |
|---|---|---|
| `handleUploadInfo` 404 | `invalid or expired link` | `連結無效或已過期。` |
| `handleUpload` 410（token 找不到） | `link is no longer valid` | `這個連結已失效或已經使用過，請向管理員索取新的連結。` |
| formData 解析失敗 400 | `expected a multipart form` | `表單格式不正確，請重新整理頁面再送出。` |
| 渠道無效 400 | `invalid channel` | `選擇的繳費渠道無效，請重新選擇。` |
| 三者皆空 400 | `請至少附上截圖、填寫備註，或選擇渠道` | `請至少附上截圖、填寫備註，或選擇渠道。`（補句號，與 `web/App.tsx:53` 對齊） |
| `TokenUnusable` 410 | `link already used` | `這個連結已經使用過了，請向管理員索取新的連結。` |
| `NoEligiblePayment` 409 | `this period is already paid or finalized` | `這一期已經登記過繳費了，不需要重複送出。` |
| 兩處 `InvalidImage` 400 | `e.message` | `imageError(e)` |

同時把 `web/src/App.tsx:53` 的 `"請至少附上截圖、填寫備註，或選擇渠道"` 補上句號，兩邊一字不差。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && pnpm test test/routes/upload.test.ts`
Expected: PASS（9 + 3 = 12 tests）。

- [ ] **Step 6: 全套 + typecheck + web build**

```bash
cd packages/worker && pnpm test && cd ../..
pnpm -r typecheck
VITE_API_BASE=https://example.invalid pnpm --filter @chippot/web build
```
Expected: 324 + 3 = 327 passed；typecheck 無輸出；web `✓ built in …`。

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/core/storage.ts packages/worker/src/routes/upload.ts packages/worker/test/routes/upload.test.ts packages/web/src/App.tsx
git commit -m "fix(upload): 成員繳費頁的錯誤訊息全面中文化（P0-6）

字串留在 worker：這條路由才知道為什麼拒絕，且任何 client 都該拿到同一句。
InvalidImage 帶 reason，讓 Discord 與 web 各自用貼合入口的措辭。"
```

---

### Task 6: 「你要繳多少」收斂到帳單金額（C6）

> **依賴**：批次 A 的 `initiateBillingOpened` 改價語意必須已合併。本 task 讓成員頁改讀 `payments.amount`，如果 A 之後又改寫了改價時機，顯示值會跟著變——先確認 A 已定案再動工。

**Files:**
- Modify: `packages/worker/src/routes/upload.ts:13-30`
- Modify: `packages/web/src/api.ts:11-27`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/worker/test/routes/upload.test.ts`

**Interfaces:**
- Consumes: 既有 `listSettleablePayments(db, ws, userId, period)`（回 `{ id, amount, plan_name }[]`，只含 `pending`/`rejected`，金額＝帳單金額）。
- Produces:
  - `GET /upload/:token` 回傳 `lines: { payment_id: number; plan_name: string; amount: number }[]`（取代 `subscriptions`）。
  - `web/src/api.ts`：`export interface PayableLine { payment_id: number; plan_name: string; amount: number }`、`TokenInfo.lines?: PayableLine[]`（移除 `SubscriptionChoice` 與 `subscriptions`）。

- [ ] **Step 1: 寫失敗測試**

`packages/worker/test/routes/upload.test.ts`：把既有的 `it("returns period, subscriptions, and active channel tags")` 改寫，並追加兩題。

```ts
  it("returns period, the period's outstanding bill lines, and active channel tags", async () => {
    const res = await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK));
    const body = (await res.json()) as any;
    expect(body.valid).toBe(true);
    expect(body.period).toBe("2026-06");
    expect(body.user.display_name).toBe("Alice");
    // Bill amounts, not plan pricing — one line per still-owed payment row.
    expect(body.lines.map((l: any) => l.plan_name).sort()).toEqual(["Claude Premium", "ChatGPT"].sort());
    expect(body.subscriptions).toBeUndefined();
    expect(body.channel_tags.some((t: any) => t.id === TAG)).toBe(true);
  });

  it("shows the overridden bill amount, not the plan's price", async () => {
    await env.DB.prepare("UPDATE payments SET amount = 99 WHERE subscription_id = ? AND period = '2026-06'").bind(SUB_A).run();
    const body = (await (await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK))).json()) as any;
    const line = body.lines.find((l: any) => l.amount === 99);
    expect(line).toBeDefined();
  });

  it("returns no lines once the period is settled, instead of re-listing paid subscriptions", async () => {
    await env.DB.prepare("UPDATE payments SET status = 'verified' WHERE workspace_id = ? AND period = '2026-06'").bind(WS).run();
    const body = (await (await handleUploadInfo(new Request("https://x"), env, ctxFor(RAW_OK))).json()) as any;
    expect(body.valid).toBe(true);
    expect(body.lines).toEqual([]);
    // Put the fixtures back for the submit tests further down the file.
    await env.DB.prepare("UPDATE payments SET status = 'pending', amount = 315 WHERE workspace_id = ? AND period = '2026-06'").bind(WS).run();
  });
```

> 這個檔案的儲存是 per-file 累積的，第 2、3 題會改到後面 submit 測試用的資料——所以第 3 題結尾一定要把狀態改回 `pending`。跑完整檔確認沒有連帶失敗。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/routes/upload.test.ts`
Expected: FAIL — `body.lines` 是 undefined。

- [ ] **Step 3: 改 `routes/upload.ts` 的 GET**

```ts
import { listSettleablePayments, listActiveChannelTags } from "../core/db";
```

```ts
/** GET /upload/:token — info for the web page (user, period, outstanding lines, channel tags). */
export async function handleUploadInfo(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(404, "連結無效或已過期。", { valid: false });

  const user = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(tok.user_id).first<{ display_name: string }>();
  // ONE source of truth for "你要繳多少": the period's own bills (pending/rejected), exactly what
  // POST will settle. Plan pricing was the old source — it re-listed already-paid subscriptions
  // and ignored per-bill overrides, so the page's total disagreed with the Discord prompt (C6).
  const settleable = await listSettleablePayments(env.DB, tok.workspace_id, tok.user_id, tok.period);
  const channel_tags = await listActiveChannelTags(env.DB, tok.workspace_id);

  return json({
    valid: true,
    period: tok.period,
    user: { display_name: user?.display_name ?? "" },
    lines: settleable.map((s) => ({ payment_id: s.id, plan_name: s.plan_name, amount: s.amount })),
    channel_tags,
    proof_enabled: !!env.BUCKET,
  });
}
```

（`listActiveSubscriptions` 若在此檔已無其他用處，從 import 拿掉。）

- [ ] **Step 4: 改 `web/src/api.ts`**

```ts
export interface PayableLine {
  payment_id: number;
  plan_name: string;
  amount: number;
}
export interface ChannelTag {
  id: number;
  name: string;
}
export interface TokenInfo {
  valid: boolean;
  period?: string;
  user?: { display_name: string };
  /** The period's still-owed bills — the amounts this submit will settle. */
  lines?: PayableLine[];
  channel_tags?: ChannelTag[];
  proof_enabled?: boolean;
}
```

- [ ] **Step 5: 改 `web/src/App.tsx`**

1. `type Stage` 加一個狀態：`type Stage = "loading" | "invalid" | "settled" | "ready" | "submitting" | "done";`
2. 載入分支：

```tsx
    fetchTokenInfo(token).then((i) => {
      if (!i.valid) {
        setStage("invalid");
        return;
      }
      setInfo(i);
      // Nothing left to pay in this period: say so instead of rendering a form whose submit
      // can only come back 409 (the page used to list already-paid subscriptions here).
      setStage((i.lines ?? []).length > 0 ? "ready" : "settled");
    });
```

3. 資料來源：

```tsx
  const lines = info?.lines ?? [];
  const tags = info?.channel_tags ?? [];
  const total = lines.reduce((s, x) => s + x.amount, 0);
```

4. 新增 settled 畫面（放在 `invalid` 分支之後）：

```tsx
  if (stage === "settled") {
    return (
      <Shell>
        <div className="state">
          <div className="state__mark state__mark--ok">✓</div>
          <h2>這一期已經登記過了</h2>
          <p className="muted">
            {info?.period} 的繳費已經送出，正在等管理員確認。
            如果要補件或更正，請在 Discord 頻道告訴管理員。
          </p>
        </div>
      </Shell>
    );
  }
```

5. `Stub` 的 props 改名並補千分位（批次 D 的 D19 在 web 這半邊順手落地）：

```tsx
      <Stub period={info?.period ?? ""} name={info?.user?.display_name ?? ""} lines={lines} total={total} />
```

```tsx
function Stub({
  period,
  name,
  lines,
  total,
}: {
  period: string;
  name: string;
  lines: { payment_id: number; plan_name: string; amount: number }[];
  total: number;
}) {
  return (
    <header className="stub">
      <div className="stub__row">
        <span className="stub__label">期別</span>
        <span className="stub__period">{period}</span>
      </div>
      <div className="stub__hi">嗨，{name || "夥伴"}</div>
      {lines.map((l) => (
        <div key={l.payment_id} className="stub__row stub__row--amt">
          <span className="stub__plan">{l.plan_name}</span>
          <span className="stub__amt">NT${l.amount.toLocaleString()}</span>
        </div>
      ))}
      {lines.length > 0 && (
        <div className="stub__row stub__row--amt">
          <span className="stub__plan">合計</span>
          <span className="stub__amt">NT${total.toLocaleString()}</span>
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 6: 前端結構斷言 + build**

```bash
grep -n "subscriptions" packages/web/src/App.tsx packages/web/src/api.ts   # 期望 0 行
grep -c "stage === \"settled\"" packages/web/src/App.tsx                   # 期望 1
pnpm --filter @chippot/web typecheck
VITE_API_BASE=https://example.invalid pnpm --filter @chippot/web build
```
Expected: 第一個 grep 無輸出（exit 1 是正常的）、第二個印 1、typecheck 無輸出、build `✓ built in …`。

- [ ] **Step 7: 跑全套**

Run: `cd packages/worker && pnpm test`
Expected: 327 + 2 = 329 passed（原本那題改寫、新增 2 題）。

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/routes/upload.ts packages/worker/test/routes/upload.test.ts packages/web/src/api.ts packages/web/src/App.tsx
git commit -m "fix(upload): 成員頁金額改用帳單金額，與 Discord 同一套算法（C6）

原本用方案定價且列出全部 active 訂閱，覆寫金額或已補登過的項目都會讓合計
失真。改讀 listSettleablePayments 之後，頁面顯示的就是這次送出會結清的東西；
沒有待繳項目時直接顯示已登記，不再給一個必定 409 的表單。"
```

---

### Task 7: 三個繳費入口的能力差異事先講清楚（C7 + C8）

**Files:**
- Modify: `packages/worker/src/adapters/discord/commands.ts:144-154`（`PAY_COMMAND` → `payCommand(proofEnabled)`）
- Modify: `packages/worker/src/adapters/discord/handler.ts:430-431, 443-454, 466-467`
- Modify: `packages/worker/src/routes/admin.ts:13, 878`
- Modify: `packages/worker/scripts/register-commands.mjs:30-49`
- Create: `packages/worker/test/adapters/discord-pay-entry.test.ts`（band 9830）

**這一併修掉 healthcheck P0-8**（指令描述說三個欄位「可選」，實際至少要填一項）。批次 D 請跳過該項。

**Interfaces:**
- Produces: `export function payCommand(proofEnabled: boolean): { name: string; type: number; description: string; options: unknown[] }` — 取代 `export const PAY_COMMAND`。

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/adapters/discord-pay-entry.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { payCommand } from "../../src/adapters/discord/commands";

// Fresh id band for this file: workspace/plan 9830, user 98301, sub 98310, channel tag 98308.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9830;
const GUILD = "guild-9830";
const DISC = "disc-9830";
const USER = 98301, SUB = 98310, TAG = 98308;
const PERIOD = "2029-06";
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, DISC, "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, WS, "2029-06-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", PERIOD, 0, 0, 0, "", TS),
    env.DB.prepare(`INSERT INTO channel_tags (id,workspace_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?)`).bind(TAG, WS, "LINE Pay", "mobilepayment", 1, TS),
  ]);
});

const payButton = (): DiscordInteraction => ({
  type: 3, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: DISC } },
  data: { custom_id: `chippot:pay:${WS}:v1`, component_type: 2 },
});
const content = async (res: Response) => ((await res.json()) as any).data.content as string;

describe("payCommand registration payload", () => {
  it("offers 截圖 and says at least one field is required when R2 is on", () => {
    const c = payCommand(true);
    expect(c.options.map((o: any) => o.name)).toEqual(["渠道", "截圖", "備註"]);
    expect(c.description).toContain("至少填一項");
    expect(c.description).not.toContain("可選");
  });

  it("drops the 截圖 option entirely when R2 is off", () => {
    const c = payCommand(false);
    expect(c.options.map((o: any) => o.name)).toEqual(["渠道", "備註"]);
    expect(c.description).not.toContain("截圖");
  });
});

describe("pay prompt discloses each entry point's limits up front", () => {
  it("tells the member the button only picks a channel, and where to attach a screenshot", async () => {
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    expect(text).toContain("只能選渠道");
    expect(text).toContain("截圖");
    expect(text).toContain("/繳費");
  });

  it("does not promise screenshots when R2 is off", async () => {
    const prev = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    (env as any).BUCKET = prev;
    expect(text).toContain("未開啟截圖");
    expect(text).not.toMatch(/想附截圖/);
  });

  it("does not send a member down the screenshot path when there is no channel tag either", async () => {
    const prevBucket = (env as any).BUCKET;
    (env as any).BUCKET = undefined;
    await env.DB.prepare("UPDATE channel_tags SET active = 0 WHERE id = ?").bind(TAG).run();
    const text = await content(await routeInteraction(payButton(), env, CTX) as Response);
    await env.DB.prepare("UPDATE channel_tags SET active = 1 WHERE id = ?").bind(TAG).run();
    (env as any).BUCKET = prevBucket;
    expect(text).toContain("備註");
    expect(text).not.toContain("可附截圖");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/adapters/discord-pay-entry.test.ts`
Expected: FAIL — `payCommand is not a function`。

- [ ] **Step 3: `commands.ts` 改成工廠函式**

把 `PAY_COMMAND` 整段換掉：

```ts
/**
 * `/繳費` command registration payload. Built per workspace runtime: with no R2 bucket the
 * screenshot option is not registered at all, so the member can't hand us a file we would
 * silently drop (C7), and the description states the real rule — at least one field — instead
 * of calling all three "可選" (healthcheck P0-8).
 */
export function payCommand(proofEnabled: boolean) {
  return {
    name: "繳費",
    type: 1,
    description: proofEnabled
      ? "登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註至少填一項）"
      : "登記繳費（一次涵蓋你所有訂閱；渠道／備註至少填一項）",
    options: [
      { type: OPT_STRING, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
      ...(proofEnabled
        ? [{ type: OPT_ATTACHMENT, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false }]
        : []),
      { type: OPT_STRING, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
    ],
  };
}
```

- [ ] **Step 4: 註冊端接上**

`packages/worker/src/routes/admin.ts:13` import 把 `PAY_COMMAND` 換成 `payCommand`；`:878`：

```ts
  // The registered payload mirrors this deployment: no R2 → no 截圖 option to offer.
  const commands = [payCommand(!!env.BUCKET), INITIATE_COMMAND, BIND_COMMAND];
```

- [ ] **Step 5: `handler.ts` 的三處文案**

`buildPayPrompt` 內（原 431 行）：

```ts
  if (tags.length === 0) {
    return {
      content: env.BUCKET
        ? "管理員尚未設定繳費渠道，請改用 `/繳費` 指令（可附截圖或備註）。"
        : "管理員尚未設定繳費渠道，請改用 `/繳費` 指令並填寫備註（本站未開啟截圖上傳）。",
      components: [],
    };
  }
```

`payChannelPrompt` 的結尾（原 450-453 行）：

```ts
  // Say what THIS entry point can and cannot do before the member commits to it (C8): the button
  // only picks a channel, and whether a screenshot is even possible depends on R2 (C7).
  const elsewhere = env.BUCKET
    ? "想附截圖或備註？改用 `/繳費`。"
    : "想附備註？改用 `/繳費`（本站未開啟截圖上傳）。";
  return {
    content: `${period} 應繳：\n${lines}\n**合計 NT$${total.toLocaleString()}**\n\n請選擇繳費渠道送出（這個按鈕只能選渠道）。${elsewhere}`,
    components: [channelSelectRow(ws, period, tags)],
  };
```

`handlePayPeriodSelect` 內的無渠道分支（原 467 行）：

```ts
  if (tags.length === 0) {
    return updateErr(env.BUCKET
      ? "管理員尚未設定繳費渠道，請改用 `/繳費` 指令（可附截圖或備註）。"
      : "管理員尚未設定繳費渠道，請改用 `/繳費` 指令並填寫備註（本站未開啟截圖上傳）。");
  }
```

- [ ] **Step 6: 修掉 register-commands.mjs 的漂移**

`packages/worker/scripts/register-commands.mjs`：`綁定` 少了 PR #23 加的 `名字` autocomplete 選項，`繳費` 的描述也已過時。整段 `const commands = [...]` 換成：

```js
// PROOF_ENABLED=false mirrors a deployment without an R2 bucket (the worker's own
// /admin/discord/register-commands decides this from env.BUCKET; this script can't see it).
const PROOF_ENABLED = vars.PROOF_ENABLED !== "false";

const commands = [
  {
    name: "繳費", type: 1,
    description: PROOF_ENABLED
      ? "登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註至少填一項）"
      : "登記繳費（一次涵蓋你所有訂閱；渠道／備註至少填一項）",
    options: [
      { type: 3, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
      ...(PROOF_ENABLED ? [{ type: 11, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false }] : []),
      { type: 3, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
    ],
  },
  {
    name: "發起繳費", type: 1,
    description: "（管理員）確認本期各方案金額並發出開繳通知",
    default_member_permissions: "32",
  },
  {
    name: "綁定", type: 1,
    description: "把你的 Discord 帳號綁定到名單上的成員",
    options: [
      { type: 3, name: "名字", description: "輸入你的名字搜尋（名單較多時用）", autocomplete: true, required: false },
    ],
  },
];
```

- [ ] **Step 7: 跑測試 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 329 + 5 = 334 passed。若 `test/routes/admin.test.ts` 有斷言 `registered: 3`，數字不變（只是內容變），應仍通過。

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/adapters/discord/commands.ts packages/worker/src/adapters/discord/handler.ts packages/worker/src/routes/admin.ts packages/worker/scripts/register-commands.mjs packages/worker/test/adapters/discord-pay-entry.test.ts
git commit -m "fix(discord): 繳費入口的能力差異事先講明，R2 未開啟時不再承諾截圖（C7/C8）

按鈕只能選渠道這件事寫在提示裡；沒有 R2 時 /繳費 根本不註冊截圖選項，
也不會有文案把人導向那條唯一會失敗的路。順手修掉指令描述的「可選」
（healthcheck P0-8）與 register-commands.mjs 已漂移的 綁定 選項。"
```

---

### Task 8: 從 Discord 拿得到成員繳費網頁的一次性連結（C5b）

**Files:**
- Modify: `packages/worker/src/adapters/discord/commands.ts`（`PAY_WEB_PREFIX`、`webLinkButton`）
- Modify: `packages/worker/src/adapters/discord/handler.ts`（dispatch + `handlePayWebLink` + prompt 加按鈕）
- Modify: `packages/worker/test/adapters/discord-pay-entry.test.ts`（追加）

**決策：做「按鈕→回一次性連結」，不做完整可達性重設計。** 成員 web 頁是全專案最完整的付款體驗（憑證預覽、壓縮、明細單），但目前只能由管理員手動貼連結，所以近乎不可達（C5／O8）。最小的修法不是改文案而是給它一個入口：繳費提示多一顆按鈕，按下才鑄 token（不按就不會產生垃圾 token），回一則 ephemeral 連結。**被明確排除**的是：自動對全體發連結、web 端自選期別、把 `/繳費` 的截圖流程整個搬到網頁——那些是「重設計」，需要 A 的期別語意與 E 的資訊架構先落地。

**Interfaces:**
- Consumes: `issueUploadToken(db, { workspaceId, userId, period, ttlMs })`（`core/tokens.ts`）、`listOpenPayablePeriods`、`writeAudit`。
- Produces:
  - `export const PAY_WEB_PREFIX = "chippot:payweb";`
  - `export function webLinkButton(workspaceId: number, period: string)` — 回一個 `CT_BUTTON`（style 2）物件，供 `payChannelPrompt` 塞進既有的 action row。

- [ ] **Step 1: 寫失敗測試**

`packages/worker/test/adapters/discord-pay-entry.test.ts` 檔尾追加：

```ts
describe("web upload link from Discord", () => {
  const webBtn = (period: string): DiscordInteraction => ({
    type: 3, id: "i", token: "t", guild_id: GUILD,
    member: { user: { id: DISC } },
    data: { custom_id: `chippot:payweb:${WS}:${period}`, component_type: 2 },
  });

  it("offers the web button in the pay prompt when R2 and WEB_ORIGIN are both configured", async () => {
    (env as any).WEB_ORIGIN = "https://pay.example.com";
    const res = (await routeInteraction(payButton(), env, CTX)) as Response;
    const data = ((await res.json()) as any).data;
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:payweb:${WS}:${PERIOD}`);
  });

  it("hides the web button when WEB_ORIGIN is missing", async () => {
    const prev = (env as any).WEB_ORIGIN;
    (env as any).WEB_ORIGIN = undefined;
    const res = (await routeInteraction(payButton(), env, CTX)) as Response;
    (env as any).WEB_ORIGIN = prev;
    const data = ((await res.json()) as any).data;
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids.every((id: string) => !id.startsWith("chippot:payweb"))).toBe(true);
  });

  it("mints a one-time link on click and shows it once", async () => {
    (env as any).WEB_ORIGIN = "https://pay.example.com";
    const before = await env.DB.prepare("SELECT COUNT(*) c FROM upload_tokens WHERE workspace_id = ?").bind(WS).first<{ c: number }>();
    const text = await content((await routeInteraction(webBtn(PERIOD), env, CTX)) as Response);
    const after = await env.DB.prepare("SELECT COUNT(*) c FROM upload_tokens WHERE workspace_id = ?").bind(WS).first<{ c: number }>();
    expect(after!.c).toBe(before!.c + 1);
    expect(text).toContain("https://pay.example.com/u/");
    expect(text).toContain("30 分鐘");
  });

  it("refuses a period the member cannot pay", async () => {
    (env as any).WEB_ORIGIN = "https://pay.example.com";
    const text = await content((await routeInteraction(webBtn("2029-12"), env, CTX)) as Response);
    expect(text).toContain("已無待繳");
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM upload_tokens WHERE workspace_id = ? AND period = '2029-12'").bind(WS).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/adapters/discord-pay-entry.test.ts`
Expected: FAIL — 提示裡沒有 `chippot:payweb` 按鈕。

- [ ] **Step 3: `commands.ts` 加按鈕**

```ts
// "開啟繳費網頁" button shown next to the channel select when R2 + WEB_ORIGIN are configured.
// MUST be dispatched BEFORE PAY_BUTTON_PREFIX ("chippot:payweb…" startsWith "chippot:pay").
export const PAY_WEB_PREFIX = "chippot:payweb";
```

```ts
/** Secondary button that mints a one-time upload link for THIS period (action:workspace:period). */
export function webLinkButton(workspaceId: number, period: string) {
  return { type: CT_BUTTON, style: 2, label: "改用網頁上傳（可附截圖）", custom_id: `${PAY_WEB_PREFIX}:${workspaceId}:${period}` };
}
```

- [ ] **Step 4: `handler.ts` dispatch + handler**

import 補 `PAY_WEB_PREFIX, webLinkButton` 與 `import { issueUploadToken } from "../../core/tokens";`。

`handleComponent` 內，**放在 `PAY_SELECT_PREFIX` 之前**（`chippot:payweb` 不會誤中 `chippot:paysel`，但一定要在 `PAY_BUTTON_PREFIX` 之前）：

```ts
  if (cid.startsWith(PAY_WEB_PREFIX)) return handlePayWebLink(i, env); // before PAY_BUTTON (prefix overlap)
```

新函式（放在 `handlePayPeriodSelect` 之後）：

```ts
/** Mint a one-time upload link for the member's own period, so the web page is reachable at all
 *  (C5). The token is created on click — not when the prompt is drawn — so browsing the prompt
 *  never litters upload_tokens. */
async function handlePayWebLink(i: DiscordInteraction, env: Env): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;
  const updateErr = (content: string) => json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });

  const parts = (i.data?.custom_id ?? "").split(":"); // chippot:payweb:<ws>:<period>
  const period = parts[3] ?? "";
  if (!PERIOD_RE.test(period) || Number(parts[2]) !== ws) return updateErr("這個按鈕已失效，請重新點「繳費」按鈕。");
  if (!env.BUCKET || !env.WEB_ORIGIN) return updateErr("本站未開啟網頁上傳，請直接用 `/繳費` 指令登記。");

  // Same gate as the channel path: never mint a token for a period the member can't settle.
  const periods = await listOpenPayablePeriods(env.DB, ws, userId);
  if (!periods.includes(period)) return updateErr("這個月份已無待繳項目，請重新點「繳費」按鈕。");

  const { raw, expiresAt } = await issueUploadToken(env.DB, { workspaceId: ws, userId, period, ttlMs: 30 * 60 * 1000 });
  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordUserId(i)}`, action: "upload_link.create",
    entityType: "user", entityId: userId, after: { period, expires_at: expiresAt, source: "discord_button" },
  });
  const url = `${env.WEB_ORIGIN.replace(/\/$/, "")}/u/${raw}`;
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      content: `${period} 繳費網頁（只有你看得到這則訊息）：\n${url}\n\n連結 30 分鐘內有效、只能使用一次，可附截圖與備註。`,
      components: [],
    },
  });
}
```

- [ ] **Step 5: 提示裡加按鈕**

`payChannelPrompt` 的 return（Task 7 已改過一次）改成：

```ts
  const canWeb = !!env.BUCKET && !!env.WEB_ORIGIN;
  const elsewhere = env.BUCKET
    ? (canWeb ? "想附截圖或備註？改用 `/繳費`，或按下方「改用網頁上傳」。" : "想附截圖或備註？改用 `/繳費`。")
    : "想附備註？改用 `/繳費`（本站未開啟截圖上傳）。";
  const row = channelSelectRow(ws, period, tags);
  return {
    content: `${period} 應繳：\n${lines}\n**合計 NT$${total.toLocaleString()}**\n\n請選擇繳費渠道送出（這個按鈕只能選渠道）。${elsewhere}`,
    // Discord forbids mixing a select and a button in one action row — the button gets its own.
    components: canWeb ? [row, { type: CT_ACTION_ROW, components: [webLinkButton(ws, period)] }] : [row],
  };
```

（`CT_ACTION_ROW` 從 `./commands` import。）

- [ ] **Step 6: 跑測試 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 334 + 4 = 338 passed。注意 `test/adapters/discord-pay.test.ts` 若有斷言 `components.length === 1`，需要在 `WEB_ORIGIN` 未設定時仍成立——本檔的 fixture 沒有設 `WEB_ORIGIN`，所以應不受影響；若失敗，改成斷言「第一個 row 是 channel select」。

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/adapters/discord/commands.ts packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-pay-entry.test.ts
git commit -m "feat(discord): 繳費提示可直接取得一次性網頁連結（C5）

成員 web 頁原本只能由管理員手動貼連結，近乎不可達。按下才鑄 token，
沒有 R2 或 WEB_ORIGIN 就不顯示按鈕；期別一樣要通過可繳閘門。"
```

---

### Task 9: 失效連結頁不再指一條不存在的路（C5a）

**Files:**
- Modify: `packages/web/src/App.tsx:76-89`

**決策：只修文案與指路，不硬塞可點元素。** mobile 稽核指出失效頁提供 0 個可點元素；但這個頁面在 token 無效時**沒有任何 workspace 脈絡**（找不到 token 就查不到 workspace，也就組不出 Discord 深連結），憑空放一顆按鈕只會變成第二條死路。Task 8 已經讓「回 Discord 按繳費按鈕」真的能拿到新連結，所以文案現在是真的。

- [ ] **Step 1: 改文案**

```tsx
  if (stage === "invalid") {
    return (
      <Shell>
        <div className="state">
          <div className="state__mark state__mark--bad">✕</div>
          <h2>連結無效或已過期</h2>
          <p className="muted">
            一次性連結 30 分鐘內有效、且只能使用一次。請回到 Discord 點「繳費」按鈕，
            再選「改用網頁上傳（可附截圖）」取得新的連結；也可以直接用
            <code> /繳費 </code>指令登記（可附截圖與備註）。
          </p>
        </div>
      </Shell>
    );
  }
```

- [ ] **Step 2: 結構斷言**

```bash
grep -c "改用網頁上傳" packages/web/src/App.tsx    # 期望 1
grep -c "重新點「繳費」按鈕" packages/web/src/App.tsx  # 期望 0（舊的死路文案已消失）
```
Expected: 1 與 0。

- [ ] **Step 3: build + 人工看一眼**

```bash
pnpm --filter @chippot/web typecheck
VITE_API_BASE=https://example.invalid pnpm --filter @chippot/web build
pnpm --filter @chippot/web dev
```
開 `http://localhost:5173/u/deadbeefdeadbeef`（任意 16 hex 以上的假 token）→ 應看到新的失效文案（API 打不到會走 `catch` → `valid:false`）。

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/App.tsx
git commit -m "fix(web): 失效連結頁改指一條真的走得通的路（C5）

Task 8 讓 Discord 的繳費提示能發新連結之後，這句話才成立。"
```

---

### Task 10: `/我的帳單`（C3）

**Files:**
- Modify: `packages/worker/src/core/db.ts`（`listRecentPayments`）
- Modify: `packages/worker/src/adapters/discord/commands.ts`（`MY_BILLS_COMMAND`）
- Modify: `packages/worker/src/adapters/discord/handler.ts`（`handleCommand` 分支 + `handleMyBillsCommand`）
- Modify: `packages/worker/src/routes/admin.ts:878`、`packages/worker/scripts/register-commands.mjs`
- Create: `packages/worker/test/adapters/discord-mybills.test.ts`（band 9840）

**決策：做成 slash 指令，完全複用 `listOpenPayablePeriods` + `listSettleablePayments`。** 不新增按鈕（常駐訊息已經有「繳費」按鈕，再加一顆會讓公開訊息變雜），也不做歷史分頁——`最近 6 筆` 足以回答「我上個月到底繳了沒」，再多就是後台的工作。

**Interfaces:**
- Produces:
  - `export interface RecentPayment { period: string; plan_name: string; amount: number; status: string }`
  - `export async function listRecentPayments(db: D1Database, workspaceId: number, userId: number, limit: number): Promise<RecentPayment[]>`
  - `export const MY_BILLS_COMMAND = { name: "我的帳單", type: 1, description: "查詢你目前的待繳項目與最近的繳費紀錄" }`

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/adapters/discord-mybills.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

// Fresh id band for this file: workspace/plan 9840, users 98401-98402, subs 98410-98411.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9840;
const GUILD = "guild-9840";
const DISC = "disc-9840", DISC_UNKNOWN = "disc-9849";
const USER = 98401, SUB_A = 98410, SUB_B = 98411;
const OPEN = "2029-08";   // opened + owed
const OLD = "2029-07";    // already verified — history only
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

const cmd = (discordId: string): DiscordInteraction => ({
  type: 2, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { name: "我的帳單" },
});
const content = async (res: Response) => ((await res.json()) as any).data.content as string;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, DISC, "王小明", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER, WS, "2029-07-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER, WS, "2029-07-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, OPEN, `${OPEN}-01`, `${OPEN}-31`, `${OPEN}-05`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, OPEN, `${OPEN}-01`, `${OPEN}-31`, `${OPEN}-05`, 251, "rejected", "user_slash", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, OLD, `${OLD}-01`, `${OLD}-31`, `${OLD}-05`, 315, "verified", "user_slash", TS, TS),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", OPEN, 0, 0, 0, "", TS),
  ]);
});

describe("/我的帳單", () => {
  it("lists what the member still owes, per period, with a total", async () => {
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain(OPEN);
    expect(text).toContain("ChatGPT");
    expect(text).toContain("NT$566");
  });

  it("shows recent history with zh-TW statuses", async () => {
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain(OLD);
    expect(text).toContain("已驗證");
    expect(text).not.toContain("verified");
  });

  it("is ephemeral", async () => {
    const res = (await routeInteraction(cmd(DISC), env, CTX)) as Response;
    expect(((await res.json()) as any).data.flags).toBe(64);
  });

  it("tells an unbound Discord account how to bind instead of failing", async () => {
    const text = await content((await routeInteraction(cmd(DISC_UNKNOWN), env, CTX)) as Response);
    expect(text).toContain("綁定");
  });

  it("says so plainly when nothing is owed", async () => {
    await env.DB.prepare("UPDATE payments SET status = 'verified' WHERE workspace_id = ? AND period = ?").bind(WS, OPEN).run();
    const text = await content((await routeInteraction(cmd(DISC), env, CTX)) as Response);
    expect(text).toContain("目前沒有待繳項目");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/adapters/discord-mybills.test.ts`
Expected: FAIL — 收到「未知指令。」

- [ ] **Step 3: `db.ts` 加歷史查詢**

```ts
export interface RecentPayment {
  period: string;
  plan_name: string;
  amount: number;
  status: string;
}

/** A member's most recent bills across periods — the history half of `/我的帳單`. */
export async function listRecentPayments(
  db: D1Database,
  workspaceId: number,
  userId: number,
  limit: number
): Promise<RecentPayment[]> {
  const { results } = await db
    .prepare(
      `SELECT p.period AS period, pl.name AS plan_name, p.amount AS amount, p.status AS status
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND s.user_id = ?
       ORDER BY p.period DESC, p.id DESC
       LIMIT ?`
    )
    .bind(workspaceId, userId, limit)
    .all<RecentPayment>();
  return results;
}
```

- [ ] **Step 4: `commands.ts` 加指令**

```ts
/** `/我的帳單` command registration payload. Read-only; every member may run it. */
export const MY_BILLS_COMMAND = {
  name: "我的帳單",
  type: 1,
  description: "查詢你目前的待繳項目與最近的繳費紀錄",
};
```

- [ ] **Step 5: `handler.ts` 實作**

`handleCommand` 加一行（放在 `綁定` 之前）：

```ts
  if (i.data?.name === "我的帳單") return handleMyBillsCommand(i, env);
```

新函式（放在 `handleBindCommand` 之前）：

```ts
// The member-facing status vocabulary. Mirrors the admin badge labels, with 'paid' spelled out as
// 已繳待驗 — "已繳" alone reads as "the money arrived", which is exactly what it doesn't mean.
const MY_BILL_STATUS: Record<string, string> = {
  pending: "待繳", paid: "已繳待驗", verified: "已驗證", rejected: "已退回",
};

/** `/我的帳單`: what you owe right now + your recent history, ephemeral. Reuses the same two
 *  queries the pay prompt uses, so the numbers can never disagree with the button (C3/C6). */
async function handleMyBillsCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) return ephemeral("你還沒綁定 Discord 帳號，請點「綁定 Discord」按鈕或用 `/綁定` 完成綁定後再試。");

  const periods = await listOpenPayablePeriods(env.DB, ws, user.id);
  const blocks: string[] = [];
  let grandTotal = 0;
  for (const period of periods) {
    const rows = await listSettleablePayments(env.DB, ws, user.id, period);
    if (rows.length === 0) continue;
    const sub = rows.reduce((s, x) => s + x.amount, 0);
    grandTotal += sub;
    blocks.push(`**${period}**\n${rows.map((x) => `・${x.plan_name} NT$${x.amount.toLocaleString()}`).join("\n")}`);
  }

  const recent = await listRecentPayments(env.DB, ws, user.id, 6);
  const history = recent.length
    ? recent.map((p) => `・${p.period} ${p.plan_name} NT$${p.amount.toLocaleString()}（${MY_BILL_STATUS[p.status] ?? p.status}）`).join("\n")
    : "（還沒有任何紀錄）";

  const owed = blocks.length
    ? `${blocks.join("\n")}\n**合計 NT$${grandTotal.toLocaleString()}**\n請點頻道裡的「繳費」按鈕或用 \`/繳費\` 登記。`
    : "目前沒有待繳項目 🎉";

  return ephemeral(`📄 **${user.display_name} 的帳單**\n\n__待繳__\n${owed}\n\n__最近紀錄__\n${history}`);
}
```

- [ ] **Step 6: 註冊**

`packages/worker/src/routes/admin.ts:13` import 補 `MY_BILLS_COMMAND`，`:878`：

```ts
  const commands = [payCommand(!!env.BUCKET), MY_BILLS_COMMAND, INITIATE_COMMAND, BIND_COMMAND];
```

`packages/worker/scripts/register-commands.mjs` 的 `commands` 陣列，在 `繳費` 之後插入：

```js
  {
    name: "我的帳單", type: 1,
    description: "查詢你目前的待繳項目與最近的繳費紀錄",
  },
```

若 `test/routes/admin.test.ts` 有斷言 `registered: 3`，改成 `4`。

- [ ] **Step 7: 跑測試 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 338 + 5 = 343 passed。

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/core/db.ts packages/worker/src/adapters/discord/commands.ts packages/worker/src/adapters/discord/handler.ts packages/worker/src/routes/admin.ts packages/worker/scripts/register-commands.mjs packages/worker/test/adapters/discord-mybills.test.ts
git commit -m "feat(discord): /我的帳單 — 成員第一次能自己查待繳與最近紀錄（C3）

複用 listOpenPayablePeriods + listSettleablePayments，數字與「繳費」按鈕
同源。狀態用中文，paid 明寫為已繳待驗。"
```

---

### Task 11: 綁錯名字不再是死路（C4）

**Files:**
- Modify: `packages/worker/src/core/db.ts`（`unbindDiscordId`）
- Modify: `packages/worker/src/adapters/discord/commands.ts`（`REBIND_PREFIX`、`REBIND_CONFIRM_PREFIX`、`rebindRow`）
- Modify: `packages/worker/src/adapters/discord/handler.ts`（`handleBindCommand` / `handleBindButton` 的已綁分支 + 兩個新 component handler）
- Create: `packages/worker/test/adapters/discord-rebind.test.ts`（band 9850）

**決策：做自助解綁＋立即重綁，兩段確認，不是「給個錯誤訊息叫他找管理員」。** 安全性論證：`unbindDiscordId` 的 UPDATE 以**呼叫者自己的 `discord_id`** 為 WHERE 條件，所以一個人只能釋放自己那一列——解綁後他回到「未綁定」，那正是他綁定之前就有的狀態，**沒有取得任何新能力**（任何人本來就能認領任何未綁定的名字，這是既有自助綁定流程的既有暴露面）。防護：(1) 兩段式（「這不是我」→「確定解除綁定」），(2) 訊息明講即將釋放的名字，(3) 兩個動作都寫 `audit_logs`（`member.unbind` / `member.bind`），(4) 全程 ephemeral，別人看不到也點不到。

**Interfaces:**
- Produces:
  - `export async function unbindDiscordId(env: Env, workspaceId: number, discordId: string): Promise<{ status: "ok" | "not_bound"; name?: string }>`
  - `export const REBIND_PREFIX = "chippot:rebind";`、`export const REBIND_CONFIRM_PREFIX = "chippot:rebindok";`
  - `export function rebindRow(workspaceId: number, confirm: boolean)` — 一個 action row，`confirm=false` 給「這不是我」，`true` 給紅色「確定解除綁定」。

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/adapters/discord-rebind.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

// Fresh id band for this file: workspace 9850, users 98501-98503.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9850;
const GUILD = "guild-9850";
const DISC = "disc-9850", DISC_OTHER = "disc-9851";
const U_ME = 98501, U_FREE = 98502, U_OTHER = 98503;
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

const comp = (customId: string, discordId = DISC): DiscordInteraction => ({
  type: 3, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { custom_id: customId, component_type: 2 },
});
const cmd = (discordId = DISC): DiscordInteraction => ({
  type: 2, id: "i", token: "t", guild_id: GUILD,
  member: { user: { id: discordId } },
  data: { name: "綁定" },
});
const dataOf = async (res: Response) => ((await res.json()) as any).data;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_guild_id: GUILD }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_ME, WS, DISC, "張三", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_FREE, WS, "李四", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_OTHER, WS, DISC_OTHER, "王五", TS, TS),
  ]);
});

describe("rebind (綁錯名字)", () => {
  it("offers a way out instead of only saying 你已綁定為 X", async () => {
    const data = await dataOf((await routeInteraction(cmd(), env, CTX)) as Response);
    expect(data.content).toContain("張三");
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:rebind:${WS}`);
  });

  it("asks for confirmation and names the binding it will release", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebind:${WS}`), env, CTX)) as Response);
    expect(data.content).toContain("張三");
    expect(data.content).toContain("解除");
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:rebindok:${WS}`);
    // Nothing changed yet.
    const row = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_ME).first<{ discord_id: string | null }>();
    expect(row!.discord_id).toBe(DISC);
  });

  it("only releases the caller's own row, then shows the picker", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebindok:${WS}`), env, CTX)) as Response);
    const me = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_ME).first<{ discord_id: string | null }>();
    const other = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(U_OTHER).first<{ discord_id: string | null }>();
    expect(me!.discord_id).toBeNull();
    expect(other!.discord_id).toBe(DISC_OTHER); // someone else's binding is untouchable
    const ids = data.components.flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids).toContain(`chippot:bind:${WS}:cmd`);
  });

  it("writes an audit row for the unbind", async () => {
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM audit_logs WHERE workspace_id = ? AND action = 'member.unbind' AND entity_id = ?")
      .bind(WS, U_ME).first<{ c: number }>();
    expect(n!.c).toBe(1);
  });

  it("is a no-op for an account that is not bound", async () => {
    const data = await dataOf((await routeInteraction(comp(`chippot:rebindok:${WS}`), env, CTX)) as Response);
    expect(data.content).toContain("尚未綁定");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/adapters/discord-rebind.test.ts`
Expected: FAIL — 第一題拿到的訊息沒有 components。

- [ ] **Step 3: `db.ts` 加解綁**

```ts
/**
 * Release the caller's OWN binding. The WHERE clause is keyed on the Discord id we resolved from
 * the interaction, so a member can only ever free the row they are standing on — after which they
 * are exactly where they were before binding (no new capability; claiming an unbound name was
 * always possible). Returns the released name for the confirmation message.
 */
export async function unbindDiscordId(
  env: Env,
  workspaceId: number,
  discordId: string
): Promise<{ status: "ok" | "not_bound"; name?: string; userId?: number }> {
  const row = await env.DB
    .prepare("SELECT id, display_name FROM users WHERE workspace_id = ? AND discord_id = ?")
    .bind(workspaceId, discordId)
    .first<{ id: number; display_name: string }>();
  if (!row) return { status: "not_bound" };
  const res = await env.DB
    .prepare("UPDATE users SET discord_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND discord_id = ?")
    .bind(nowUtcIso(), row.id, workspaceId, discordId)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { status: "not_bound" }; // lost a race — nothing released
  return { status: "ok", name: row.display_name, userId: row.id };
}
```

- [ ] **Step 4: `commands.ts` 加按鈕**

```ts
// 綁錯名字的出路: "這不是我" → confirm → unbind + re-pick. Neither prefix collides with
// BIND_SELECT_PREFIX / BIND_BUTTON_PREFIX, but rebindok MUST be dispatched before rebind.
export const REBIND_PREFIX = "chippot:rebind";
export const REBIND_CONFIRM_PREFIX = "chippot:rebindok";
```

```ts
/** One-button row: the escape hatch (confirm=false) or its red confirmation (confirm=true). */
export function rebindRow(workspaceId: number, confirm: boolean) {
  return {
    type: CT_ACTION_ROW,
    components: [confirm
      ? { type: CT_BUTTON, style: 4, label: "確定解除綁定", custom_id: `${REBIND_CONFIRM_PREFIX}:${workspaceId}` }
      : { type: CT_BUTTON, style: 2, label: "這不是我", custom_id: `${REBIND_PREFIX}:${workspaceId}` }],
  };
}
```

- [ ] **Step 5: `handler.ts` 接上**

dispatch（`handleComponent` 內，放在 `BIND_BUTTON_PREFIX` 之前）：

```ts
  if (cid.startsWith(REBIND_CONFIRM_PREFIX)) return handleRebindConfirm(i, env); // before REBIND (prefix overlap)
  if (cid.startsWith(REBIND_PREFIX)) return handleRebindAsk(i, env);
```

`handleBindCommand` 與 `handleBindButton` 的已綁分支，兩處都換成共用的 helper：

```ts
/** Already bound: name the binding AND offer the way out (C4) — the old dead end just said
 *  「你已綁定為 X」 and left 綁錯名字的人 with nothing but "go ask an admin". */
const boundAlready = (ws: number, name: string) =>
  json({
    type: RT_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `你已綁定為 ${name}。如果這不是你，可以按下方按鈕解除後重新綁定。`,
      components: [rebindRow(ws, false)],
    },
  });
```

```ts
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (existing) return boundAlready(ws, existing.display_name);
```

（`handleBindSearchSubmit` 的已綁分支維持 `ephemeral(...)` 即可——那條路徑是 modal 回覆，不必再開一層。）

兩個新 handler（放在 `handleBindSelect` 之後）：

```ts
async function handleRebindAsk(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  if (Number((i.data?.custom_id ?? "").split(":")[2]) !== ws) {
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "這個按鈕已失效，請重新用 `/綁定`。", components: [] } });
  }
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (!existing) return json({ type: RT_UPDATE_MESSAGE, data: { content: "你的 Discord 帳號目前尚未綁定，可直接選擇你的名字。", components: [] } });
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      content: `確定要解除「${existing.display_name}」的綁定嗎？解除後這個名字會回到可綁定清單，你必須重新選一次自己的名字才能繳費。`,
      components: [rebindRow(ws, true)],
    },
  });
}

async function handleRebindConfirm(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const result = await unbindDiscordId(env, ws, discordId);
  if (result.status !== "ok") {
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "你的 Discord 帳號目前尚未綁定。", components: [] } });
  }
  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordId}`, action: "member.unbind",
    entityType: "user", entityId: result.userId!, before: { discord_id: discordId }, after: { discord_id: null },
  });
  // Straight back into the picker: the point of unbinding is to bind to the right name.
  const unbound = await listUnboundUsers(env.DB, ws);
  if (unbound.length === 0) return json({ type: RT_UPDATE_MESSAGE, data: { content: `已解除「${result.name}」的綁定。目前沒有可綁定的成員，請聯絡管理員。`, components: [] } });
  if (unbound.length > BIND_SELECT_CAP) return json(bindSearchModal(ws, "cmd"));
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `已解除「${result.name}」的綁定，請重新選擇你的名字：`,
      components: [bindSelectRow(ws, "cmd", unbound)],
    },
  });
}
```

- [ ] **Step 6: 跑測試 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 343 + 5 = 348 passed。既有的 `test/adapters/discord-bind.test.ts` / `discord-bind-button.test.ts` 若斷言「已綁定時回傳沒有 components」，改成斷言 content 仍含名字並多一顆 `chippot:rebind` 按鈕。

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/core/db.ts packages/worker/src/adapters/discord/commands.ts packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-rebind.test.ts
git commit -m "feat(discord): 綁錯名字可自助解綁並立即重綁（C4）

UPDATE 以呼叫者自己的 discord_id 為條件，只能釋放自己那一列；解除後回到
未綁定，沒有取得任何新能力。兩段確認 + audit（member.unbind），全程 ephemeral。"
```

---

### Task 12: 催繳核心與端點（C1 的後端 + C2 的後端 + P2-4 去重）

**Files:**
- Create: `packages/worker/src/core/nudge.ts`
- Create: `packages/worker/test/core/nudge.test.ts`（band 9820）
- Modify: `packages/worker/src/core/notify.ts`（`NudgeKind`、`sendPaymentNudge` 簽名）
- Modify: `packages/worker/src/adapters/discord/notify.ts`
- Modify: `packages/worker/test/adapters/discord-nudge.test.ts`
- Modify: `packages/worker/src/routes/admin.ts:110-147`（sync 改走 core）、新增 handler + route
- Modify: `packages/worker/test/routes/admin.test.ts`（端點驗證）

**Interfaces:**
- Produces（`core/notify.ts`）：`export type NudgeKind = "added" | "remind";`，`Notifier.sendPaymentNudge(env, channelId, workspaceId, period, people, kind: NudgeKind)`。
- Produces（`core/nudge.ts`）：
  - `export interface NudgeInput { workspaceId: number; period: string; userIds: number[]; kind: NudgeKind; force?: boolean }`
  - `export interface NudgeResult { opened: boolean; notified: number; skipped: number; unbound: number; unbound_names: string[] }`
  - `export async function sendMemberNudge(env: Env, o: NudgeInput, notifier: Notifier): Promise<NudgeResult>`
- Produces（route）：`POST /admin/notifications/nudge`，body `{ period: string; user_ids: number[]; kind?: "added" | "remind"; force?: boolean }`，回 `{ ok: true, ...NudgeResult }`。

- [ ] **Step 1: 寫失敗測試**

建立 `packages/worker/test/core/nudge.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendMemberNudge } from "../../src/core/nudge";
import type { Notifier, OverduePerson } from "../../src/core/notify";

// Fresh id band for this file: workspace/plan 9820, users 98201-98203, subs 98210-98212.
const TS = "2026-05-01T00:00:00.000Z";
const WS = 9820;
const CHAN = "chan-9820";
const U_BOUND = 98201, U_BOUND2 = 98202, U_UNBOUND = 98203;
const S_1 = 98210, S_2 = 98211, S_3 = 98212;
const P = "2029-10";
const CLOSED = "2029-11"; // has bills but was never opened

const sent: { period: string; people: OverduePerson[]; kind: string }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() {},
  async sendOverdue() {},
  async sendPaymentReceipt() {},
  async sendPaymentNudge(_e, _ch, _ws, period, people, kind) { sent.push({ period, people, kind }); },
};
const failing: Notifier = { ...notifier, async sendPaymentNudge() { throw new Error("discord 502"); } };

const bill = (sub: number, period: string, amount: number) =>
  env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(WS, sub, period, `${period}-01`, `${period}-30`, `${period}-05`, amount, "pending", "cron", TS, TS);

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 5, JSON.stringify({ discord_billing_channel_id: CHAN }), TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_BOUND, WS, "d-98201", "張三", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(U_BOUND2, WS, "d-98202", "李四", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(U_UNBOUND, WS, "王五", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(WS, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_1, WS, U_BOUND, WS, "2029-10-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_2, WS, U_BOUND2, WS, "2029-10-01", 5, "active", TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(S_3, WS, U_UNBOUND, WS, "2029-10-01", 5, "active", TS, TS),
    bill(S_1, P, 315), bill(S_2, P, 251), bill(S_3, P, 315), bill(S_1, CLOSED, 315),
    env.DB.prepare(`INSERT INTO notification_logs (workspace_id,type,period,plan_id,user_id,subscription_id,event,sent_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "billing_opened", P, 0, 0, 0, "", TS),
  ]);
});

describe("sendMemberNudge", () => {
  it("nudges the bound members and reports the ones it cannot reach", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND, U_UNBOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ opened: true, notified: 1, skipped: 0, unbound: 1, unbound_names: ["王五"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.people.map((p) => p.user_id)).toEqual([U_BOUND]);
    expect(sent[0]!.kind).toBe("added");
  });

  it("does not @ the same member twice for the same period (P2-4)", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ notified: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });

  it("force re-nudges deliberately (admin pressed the button)", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind", force: true }, notifier);
    expect(r.notified).toBe(1);
    expect(sent[0]!.kind).toBe("remind");
  });

  it("says nothing and claims nothing when the period is not opened", async () => {
    sent.length = 0;
    const r = await sendMemberNudge(env, { workspaceId: WS, period: CLOSED, userIds: [U_BOUND], kind: "added" }, notifier);
    expect(r).toMatchObject({ opened: false, notified: 0 });
    expect(sent).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) c FROM notification_logs WHERE workspace_id=? AND type='nudge' AND period=?").bind(WS, CLOSED).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it("skips members with nothing outstanding", async () => {
    sent.length = 0;
    await env.DB.prepare("UPDATE payments SET status='verified' WHERE subscription_id=? AND period=?").bind(S_2, P).run();
    const r = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND2], kind: "added" }, notifier);
    expect(r.notified).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("gives the slots back when the send fails", async () => {
    sent.length = 0;
    const fail = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind", force: true }, failing);
    expect(fail.notified).toBe(0);
    const retry = await sendMemberNudge(env, { workspaceId: WS, period: P, userIds: [U_BOUND], kind: "remind" }, notifier);
    expect(retry.notified).toBe(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && pnpm test test/core/nudge.test.ts`
Expected: FAIL — 找不到模組 `../../src/core/nudge`。

- [ ] **Step 3: `notify.ts` 加 `NudgeKind`、改簽名**

```ts
/** 'added' = 你被加進名單了; 'remind' = 你還沒繳。Same message shape, different opening line. */
export type NudgeKind = "added" | "remind";
```

```ts
  /** Targeted nudge for specific members in a period: @-mention them + pay button. */
  sendPaymentNudge(
    env: Env, channelId: string, workspaceId: number, period: string,
    people: OverduePerson[], kind: NudgeKind
  ): Promise<void>;
```

`packages/worker/src/adapters/discord/notify.ts` 的 `sendPaymentNudge`：

```ts
  async sendPaymentNudge(env: Env, channelId, workspaceId: number, period, people: OverduePerson[], kind) {
    const list = people
      .map((p) => {
        const mention = p.discord_id ? `<@${p.discord_id}>` : `**${p.user_name}**`;
        const plans = p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`).join("、");
        return `・${mention} ${plans}（合計 NT$${p.total.toLocaleString()}）`;
      })
      .join("\n");
    const head = kind === "remind" ? `🔔 ${period} 繳費提醒：` : `📋 已將你加入 ${period} 繳費名單：`;
    const content = `${head}\n${list}\n請點下方按鈕繳費。`;
```

`packages/worker/test/adapters/discord-nudge.test.ts` 既有呼叫補上第 6 個參數 `"added"`，並追加：

```ts
  it("uses a reminder opening line for kind=remind", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("{}", { status: 200 }); }));
    await discordNotifier.sendPaymentNudge(env, "chan-1", 7, "2027-07", [
      { user_id: 1, discord_id: "d1", user_name: "A", lines: [{ plan_name: "GPT", amount: 320 }], total: 320 },
    ], "remind");
    vi.unstubAllGlobals();
    expect(body.content).toContain("繳費提醒");
    expect(body.content).not.toContain("加入");
  });
```

- [ ] **Step 4: 實作 `core/nudge.ts`**

```ts
import type { Env } from "../env";
import { parseSettings } from "../env";
import {
  claimNotification, releaseNotification, isBillingOpened,
  type Notifier, type NudgeKind, type OverduePerson,
} from "./notify";

export interface NudgeInput {
  workspaceId: number;
  period: string;
  userIds: number[];
  kind: NudgeKind;
  /**
   * The admin deliberately pressed 催繳 again: clear the per-user slot first so the claim below
   * wins (delete-then-claim, the same accepted pattern as billing.ts:192 / scheduled.ts:147).
   * Automatic callers — CSV import, 新增訂閱, 重新同步 — never force, which is what stops the
   * repeated double-@ that P2-4 reported.
   */
  force?: boolean;
}

export interface NudgeResult {
  /** False = the period was never opened, so nobody can pay it and nothing was sent. */
  opened: boolean;
  notified: number;
  /** Already nudged for this period and not forced. */
  skipped: number;
  unbound: number;
  unbound_names: string[];
}

interface Row {
  user_id: number; discord_id: string | null; user_name: string;
  plan_name: string; amount: number;
}

/**
 * 個別／入職催繳 (C1, C2): @-mention specific members in the billing channel with what they still
 * owe for a period, plus the pay button. Deduped per (workspace, 'nudge', period, user), so the
 * same member is pinged at most once per period unless an admin explicitly re-sends.
 */
export async function sendMemberNudge(
  env: Env,
  o: NudgeInput,
  notifier: Notifier
): Promise<NudgeResult> {
  const empty: NudgeResult = { opened: false, notified: 0, skipped: 0, unbound: 0, unbound_names: [] };
  if (o.userIds.length === 0) return empty;

  // A member cannot act on a nudge for a period that isn't open (the pay button would answer
  // 「尚未開放」), so don't send one — and don't burn the slot either.
  if (!(await isBillingOpened(env.DB, o.workspaceId, o.period))) return empty;

  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?")
    .bind(o.workspaceId).first<{ settings: string }>();
  if (!wsRow) return empty;
  const channelId = parseSettings(wsRow.settings).discord_billing_channel_id;
  if (!channelId || !env.DISCORD_BOT_TOKEN) return { ...empty, opened: true };

  const marks = o.userIds.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
            pl.name AS plan_name, p.amount AS amount
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = s.user_id
     JOIN plans pl ON pl.id = s.plan_id
     WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
       AND s.status = 'active' AND u.id IN (${marks})
     ORDER BY u.id, pl.id`
  ).bind(o.workspaceId, o.period, ...o.userIds).all<Row>()).results;

  const byUser = new Map<number, OverduePerson>();
  for (const r of rows) {
    let e = byUser.get(r.user_id);
    if (!e) { e = { user_id: r.user_id, discord_id: r.discord_id, user_name: r.user_name, lines: [], total: 0 }; byUser.set(r.user_id, e); }
    e.lines.push({ plan_name: r.plan_name, amount: r.amount });
    e.total += r.amount;
  }

  const everyone = [...byUser.values()];
  // An unbound member can't be @-ed at all. Report them by name instead of silently sending to
  // a shorter list — that gap is exactly what made onboarding look like it worked (C9).
  const unboundPeople = everyone.filter((p) => !p.discord_id);
  const result: NudgeResult = {
    opened: true, notified: 0, skipped: 0,
    unbound: unboundPeople.length, unbound_names: unboundPeople.map((p) => p.user_name),
  };

  const winners: OverduePerson[] = [];
  for (const p of everyone) {
    if (!p.discord_id) continue;
    const key = { workspaceId: o.workspaceId, type: "nudge" as const, period: o.period, userId: p.user_id };
    if (o.force) await releaseNotification(env.DB, key);
    if (await claimNotification(env.DB, key)) winners.push(p); else result.skipped++;
  }
  if (winners.length === 0) return result;

  try {
    await notifier.sendPaymentNudge(env, channelId, o.workspaceId, o.period, winners, o.kind);
    result.notified = winners.length;
  } catch (err) {
    // The caller's write (import / reconcile / nothing) already happened; a Discord hiccup must
    // neither fail it nor permanently mute these members.
    console.error("nudge send failed", err);
    for (const p of winners) {
      await releaseNotification(env.DB, { workspaceId: o.workspaceId, type: "nudge", period: o.period, userId: p.user_id }).catch(() => 0);
    }
  }
  return result;
}
```

- [ ] **Step 5: 跑核心測試**

Run: `cd packages/worker && pnpm test test/core/nudge.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 6: 端點 + sync 改走 core**

`packages/worker/src/routes/admin.ts`：import 補 `import { sendMemberNudge } from "../core/nudge";`。

`syncPeriodBills` 的 `let notified = 0; if (b.notify_added && diff.add.length) { … }` 整段換成：

```ts
  // The nudge goes through core/nudge.ts so it is claim-deduped: re-applying a sync no longer
  // re-@s the same people (P2-4), and the response can say how many could not be reached.
  let nudge = { notified: 0, unbound: 0, unbound_names: [] as string[] };
  if (b.notify_added && diff.add.length) {
    const userIds = [...new Set(diff.add.map((a) => a.user_id))];
    const r = await sendMemberNudge(env, { workspaceId: ws, period, userIds, kind: "added" }, discordNotifier);
    nudge = { notified: r.notified, unbound: r.unbound, unbound_names: r.unbound_names };
  }
  return json({
    ok: true,
    applied: { added: diff.add.length, removed: diff.remove.length, repriced: diff.reprice.length, frozen: diff.frozen_count },
    notified: nudge.notified, unbound: nudge.unbound, unbound_names: nudge.unbound_names,
  });
```

新 handler（放在 `notificationsReset` 之後）：

```ts
/**
 * 個別催繳: @ specific members in the billing channel with what they still owe. `force` is the
 * admin saying "再催一次" (delete-then-claim); without it a member is pinged at most once per
 * period, which is what makes it safe to call automatically after 匯入名單 / 新增訂閱.
 */
async function notificationsNudge(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ period?: string; user_ids?: number[]; kind?: string; force?: boolean }>(req);
  if (!b?.period || !PERIOD_RE.test(b.period)) return errorResponse(400, "period must be YYYY-MM");
  if (!Array.isArray(b.user_ids) || b.user_ids.length === 0) return errorResponse(400, "user_ids must be a non-empty array");
  for (const id of b.user_ids) {
    if (!Number.isInteger(id) || id <= 0) return errorResponse(400, "user_ids must be positive integers");
  }
  if (b.kind !== undefined && b.kind !== "added" && b.kind !== "remind") return errorResponse(400, "kind must be added or remind");
  const r = await sendMemberNudge(
    env,
    { workspaceId: ws, period: b.period, userIds: b.user_ids, kind: b.kind === "remind" ? "remind" : "added", force: !!b.force },
    discordNotifier
  );
  await writeAudit(env.DB, {
    workspaceId: ws, actor: actorOf(ctx), action: "notification.nudge", entityType: "workspace", entityId: ws,
    after: { period: b.period, requested: b.user_ids.length, notified: r.notified, skipped: r.skipped, unbound: r.unbound, force: !!b.force },
  });
  return json({ ok: true, ...r });
}
```

router 加一行（放在 `/admin/notifications/test` 之後）：

```ts
    .post("/admin/notifications/nudge", notificationsNudge)
```

- [ ] **Step 7: 端點測試**

`packages/worker/test/routes/admin.test.ts` 追加（不需要 fixture：驗證與未開繳兩條路徑）：

```ts
describe("POST /admin/notifications/nudge", () => {
  it("400s a bad period", async () => {
    const res = await call("POST", "/admin/notifications/nudge", { period: "2029-13", user_ids: [1] });
    expect(res!.status).toBe(400);
  });

  it("400s an empty user list", async () => {
    const res = await call("POST", "/admin/notifications/nudge", { period: "2029-01", user_ids: [] });
    expect(res!.status).toBe(400);
  });

  it("reports opened:false for a period nobody opened, and sends nothing", async () => {
    const res = await call("POST", "/admin/notifications/nudge", { period: "2029-01", user_ids: [1] });
    const body = (await res!.json()) as any;
    expect(res!.status).toBe(200);
    expect(body).toMatchObject({ ok: true, opened: false, notified: 0 });
  });
});
```

- [ ] **Step 8: 跑全套 + typecheck**

Run: `cd packages/worker && pnpm test && pnpm typecheck`
Expected: 348 + 10 = 358 passed。`test/core/billing-reconcile.test.ts` 與 `admin.test.ts` 內既有的 sync 測試若斷言 `notified`，語意未變（仍是「真的 @ 到幾個人」），應通過。

- [ ] **Step 9: Commit**

```bash
git add packages/worker/src/core/nudge.ts packages/worker/src/core/notify.ts packages/worker/src/adapters/discord/notify.ts packages/worker/src/routes/admin.ts packages/worker/test/core/nudge.test.ts packages/worker/test/adapters/discord-nudge.test.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(nudge): 可對指定成員催繳，且入職通知不再重複 @（C1/C2/P2-4）

claim 以 (ws,'nudge',period,user) 為單位；自動路徑不 force，管理員按鈕才 force。
未開繳不發也不占 slot；回傳誠實的 notified/skipped/unbound。重新同步的通知
改走同一支，重複套用不再重複 @。"
```

---

### Task 13: 手動／CSV 入職也會通知（C1 的前端）

**Files:**
- Modify: `packages/admin/src/api.ts`（`nudgeMembers` + 型別）
- Modify: `packages/admin/src/views/Settings.tsx`（ImportModal 套用後通知）
- Modify: `packages/admin/src/views/Manage.tsx`（SubAddModal 建立後通知）

**根因提醒**：`ensureFirstPayment` 在建立訂閱／匯入時就把帳單開好了，所以之後的「重新同步」diff 是空的、勾選框根本不會出現（C1）。修法不是去改 diff，而是在**產生帳單的當下**就提供通知選項。

**Interfaces:**
- Consumes: Task 12 的 `POST /admin/notifications/nudge`。
- Produces（`packages/admin/src/api.ts`）：

```ts
export interface NudgeResult {
  ok: boolean; opened: boolean; notified: number; skipped: number;
  unbound: number; unbound_names: string[];
}
```
```ts
  nudgeMembers: (b: { period: string; user_ids: number[]; kind?: "added" | "remind"; force?: boolean }) =>
    req<NudgeResult>("POST", "/notifications/nudge", b),
```

- [ ] **Step 1: 加 api 方法**

依上面的 Interfaces 區塊改 `packages/admin/src/api.ts`（型別放在 `ImportDiff` 之後，方法放在 `resetNotification` 之後）。

- [ ] **Step 2: 共用的結果文案**

`packages/admin/src/api.ts` 尾端（`nextBillingPeriod` 之後）加一個純函式，讓三個呼叫點講同一句話：

```ts
/** One sentence for a nudge outcome — every caller (匯入 / 新增訂閱 / 個別催繳) says the same thing. */
export function nudgeSummary(r: NudgeResult): string {
  if (!r.opened) return "此期尚未發起繳費，暫不發送通知。";
  const parts: string[] = [];
  parts.push(r.notified > 0 ? `已在頻道 @ 通知 ${r.notified} 位` : "沒有需要通知的人");
  if (r.skipped > 0) parts.push(`${r.skipped} 位本期已通知過`);
  if (r.unbound > 0) parts.push(`另 ${r.unbound} 位尚未綁定 Discord、通知不到（${r.unbound_names.join("、")}）`);
  return parts.join("；") + "。";
}
```

- [ ] **Step 3: ImportModal 套用後通知**

`packages/admin/src/views/Settings.tsx` 的 `ImportModal`：

1. import 補 `nudgeSummary`、`api` 已在檔內。
2. state 加：

```tsx
  const [notify, setNotify] = useState(true);
  const [nudged, setNudged] = useState<string | null>(null);
```

3. `apply()` 內，`setDone(...)` 之後追加：

```tsx
      // 匯入建立的帳單來自 ensureFirstPayment，不會出現在之後的同步 diff —— 通知要在這裡發，
      // 否則新成員從頭到尾不會收到任何訊息 (C1)。
      const ids = [...new Set(
        [...d.subs_added, ...d.subs_reactivated].map((l) => l.user_id).filter((v): v is number => v != null)
      )];
      if (notify && ids.length > 0) {
        try {
          setNudged(nudgeSummary(await api.nudgeMembers({ period: d.period, user_ids: ids, kind: "added" })));
        } catch (e) { setNudged(`通知發送失敗：${(e as Error).message}`); }
      }
```

4. 在「確認套用」按鈕上方插入勾選框，`done` 之後顯示結果：

```tsx
          {!done && changes > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={busy} />
              套用後在頻道 @ 通知這批成員繳費（尚未綁定 Discord 的人通知不到，會列出來）
            </label>
          )}
          {nudged && <div style={{ color: "var(--muted-strong)", fontSize: 13, padding: "4px 0" }}>{nudged}</div>}
```

- [ ] **Step 4: SubAddModal 建立後通知**

`packages/admin/src/views/Manage.tsx` 的 `SubAddModal`：

```tsx
function SubAddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const users = useAsync(() => api.users(), []);
  const plans = useAsync(() => api.plans(), []);
  const [f, set] = useForm({ user_id: "", plan_id: "", start_date: "" });
  const [notify, setNotify] = useState(true);
  const [nudged, setNudged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.user_id || !f.plan_id || !f.start_date) { setErr("請填成員、方案、起算日"); return; }
    setBusy(true); setErr(null);
    try {
      await api.createSubscription({ user_id: Number(f.user_id), plan_id: Number(f.plan_id), start_date: f.start_date });
      // 建立訂閱會立刻開出第一期帳單，但沒有任何人會告訴這位成員 (C1)。
      if (notify) {
        const r = await api.nudgeMembers({ period: f.start_date.slice(0, 7), user_ids: [Number(f.user_id)], kind: "added" });
        if (r.notified === 0) { setNudged(nudgeSummary(r)); setBusy(false); return; }
      }
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
```

modal body 內，「建立」按鈕之前插入：

```tsx
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={busy} /> 建立後在頻道 @ 通知這位成員繳費
      </label>
      {nudged && <div style={{ color: "var(--muted-strong)", fontSize: 13, marginBottom: 10 }}>{nudged}</div>}
```

（`nudgeSummary` 從 `../api` import。訂閱已經建立成功，所以通知沒送成不算失敗——顯示原因後停在原地，讓管理員知道發生什麼事，再自行關閉。）

- [ ] **Step 5: 結構斷言 + build**

```bash
grep -c "nudgeMembers" packages/admin/src/api.ts packages/admin/src/views/Settings.tsx packages/admin/src/views/Manage.tsx  # 期望 1 / 1 / 1
pnpm --filter @chippot/admin typecheck
pnpm --filter @chippot/admin build
```
Expected: 三個檔各 1 次、typecheck 無輸出、build `✓ built in …`。

- [ ] **Step 6: 人工看一眼**

```bash
pnpm --filter @chippot/admin dev
```
`http://localhost:5173` → 設定 → 工具 → 匯入名單 CSV：勾選框在「確認套用」上方（API 會 404，橫幅出現屬正常）；成員／訂閱 → 新增訂閱：勾選框在「建立」上方。

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/Settings.tsx packages/admin/src/views/Manage.tsx
git commit -m "feat(admin): CSV 匯入與新增訂閱都能通知新成員（C1）

帳單在建立當下就開好了，所以之後的同步 diff 是空的、原本的勾選框永遠不出現。
通知改在產生帳單的地方提供，並照實回報通知不到的未綁定成員。"
```

---

### Task 14: 對單一成員催繳（C2）

**Files:**
- Modify: `packages/admin/src/views/MemberReview.tsx`

**決策：按鈕放在 `MemberReview`（成員 × 期別），不放 `Manage` 的成員列。** 催繳一定要有期別，而成員表沒有期別脈絡；`MemberReview` 本來就是「這個人這一期」的畫面，`outstanding`（pending／rejected）已經算好，按鈕的出現條件是現成的。另外 `Manage.tsx` 是批次 B 的改寫熱區，能不碰就不碰。

- [ ] **Step 1: 加按鈕**

`packages/admin/src/views/MemberReview.tsx`：

1. import 補 `nudgeSummary`：`import { api, nudgeSummary, type ChannelTag, type Payment } from "../api";`
2. state 加 `const [nudged, setNudged] = useState<string | null>(null);`
3. 在 `mreview__bulk` 區塊的按鈕之後、`{done && …}` 之前插入：

```tsx
            {outstanding.length > 0 && (
              <button
                className="btn"
                disabled={busy}
                title="在帳單頻道 @ 這位成員，列出他這一期還沒繳的項目"
                onClick={() => run(async () => {
                  // force: the admin is deliberately asking for another ping, which is the one
                  // sanctioned way past the per-period nudge dedup (core/nudge.ts).
                  const r = await api.nudgeMembers({ period, user_ids: [userId], kind: "remind", force: true });
                  setNudged(nudgeSummary(r));
                  return null;
                })}
              >
                催繳這位成員（{outstanding.length} 筆未繳）
              </button>
            )}
            {nudged && <span className="mreview__meta">{nudged}</span>}
```

- [ ] **Step 2: 結構斷言 + build**

```bash
grep -c "催繳這位成員" packages/admin/src/views/MemberReview.tsx   # 期望 1
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```
Expected: 1、typecheck 無輸出、build 成功。

- [ ] **Step 3: 人工看一眼**

`pnpm --filter @chippot/admin dev` → `http://localhost:5173/#payments?user=1&period=2026-07`。API 404 會讓列表是空的、按鈕不出現（`outstanding` 為 0），這是正確行為；把 `outstanding.length > 0` 暫時改成 `true` 看一眼版面後改回來，或直接在有資料的環境驗。

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/MemberReview.tsx
git commit -m "feat(admin): 成員審核頁可單獨催繳這一位（C2）

sendPaymentNudge 本來就吃任意 people[]，只是唯一呼叫點綁在同步套用上。
放在成員×期別頁，因為催繳需要期別脈絡。"
```

---

### Task 15: 未綁定成員在後台看得見（C9）　⚠️ rebase／衝突敏感

**Files:**
- Modify: `packages/admin/src/views/Manage.tsx`（`Users()` 內，**只加變數與一段 pills，不改 `<table>` 內部結構**）
- Modify: `packages/admin/src/views/Payments.tsx`（`SyncModal` 補未綁定提示）

**衝突須知**：批次 B（#44）正在改寫 `Manage.tsx` 的表格 markup。本 task 對表格唯一的改動是把 `data?.users.map(...)` 換成 `shown.map(...)`——一行。**B 先合併時**：重新 anchor 這一行，其餘（`shown` 的計算與 pills 區塊）原封不動貼回 `Card` 與 `.tbl` 之間。**本批次先合併時**：什麼都不用做。不要順手改 Discord ID 欄位的 `—`（那是 B 的地盤）。

- [ ] **Step 1: 成員頁計數與篩選**

`packages/admin/src/views/Manage.tsx` 的 `Users()`：

```tsx
export function Users() {
  const { data, loading, error, reload } = useAsync(() => api.users(), []);
  const [edit, setEdit] = useState<User | null | undefined>(undefined); // undefined=closed, null=new
  const [del, setDel] = useState<User | null>(null);
  // 未綁定的人收不到開繳／催繳的 @，而 onboarding 完全靠那個 @。原本這件事在後台看不出來 (C9)。
  const [onlyUnbound, setOnlyUnbound] = useState(false);
  const users = data?.users ?? [];
  const unboundCount = users.filter((u) => !u.discord_id).length;
  const shown = onlyUnbound ? users.filter((u) => !u.discord_id) : users;
```

在 `<Card title="成員" …>` 之後、`<div className="tbl">` 之前插入（沿用 `Plans()` 既有的 pills 樣式）：

```tsx
        {unboundCount > 0 && (
          <div className="pills" style={{ padding: "12px 18px 0", alignItems: "center" }}>
            <button className={`pill ${onlyUnbound ? "" : "pill--on"}`} onClick={() => setOnlyUnbound(false)}>全部 {users.length} 人</button>
            <button className={`pill ${onlyUnbound ? "pill--on" : ""}`} onClick={() => setOnlyUnbound(true)}>未綁定 {unboundCount} 人</button>
            <span style={{ fontSize: 12.5, color: "var(--muted-strong)" }}>未綁定者收不到開繳／催繳的 @</span>
          </div>
        )}
```

`tbody` 內唯一的一行改動：

```tsx
              {shown.map((u) => (
```

- [ ] **Step 2: 同步彈窗說出通知不到的人**

`packages/admin/src/views/Payments.tsx` 的 `SyncModal`：

```tsx
  const boundAdds = diff?.add?.filter((a) => a.discord_id) ?? [];
  const unboundAdds = diff?.add?.filter((a) => !a.discord_id) ?? [];
```

勾選框那段之後插入：

```tsx
          {unboundAdds.length > 0 && (
            <div className="warnnote">
              另 {unboundAdds.length} 位尚未綁定 Discord，@ 不到：{unboundAdds.map((a) => a.user_name).join("、")}。
              請到「成員」頁用「未綁定」篩選確認，或請他們點頻道裡的「綁定 Discord」按鈕。
            </div>
          )}
```

`apply()` 的成功訊息改成用後端回傳的真實數字（Task 12 已回傳 `unbound`）：

```tsx
      const r = await api.syncPeriodBills(period, { dry_run: false, notify_added: notify && boundAdds.length > 0 }) as any;
      setDone(
        `已套用：新增 ${r.applied.added}、移除 ${r.applied.removed}、改價 ${r.applied.repriced}、保留 ${r.applied.frozen}`
        + (r.notified ? `；已通知 ${r.notified} 位` : "")
        + (r.unbound ? `；${r.unbound} 位未綁定、通知不到` : "")
      );
```

- [ ] **Step 3: 結構斷言 + build**

```bash
grep -c "未綁定" packages/admin/src/views/Manage.tsx packages/admin/src/views/Payments.tsx  # 期望 >=2 / >=2
grep -c "shown.map" packages/admin/src/views/Manage.tsx                                     # 期望 1
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

- [ ] **Step 4: 人工看一眼**

`pnpm --filter @chippot/admin dev` → 成員頁。API 404 時 `users` 為空、pills 不出現（`unboundCount === 0`），屬正確行為；要看版面就暫時把條件改成 `true` 並在 `users` 塞兩筆假資料，看完還原。

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/views/Manage.tsx packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): 未綁定成員可見（計數 pill + 篩選）＋同步彈窗說出 @ 不到的人（C9）

/admin/users 已經回傳 discord_id，所以篩選在前端完成，不新增端點。
刻意只在表格外圍插入，降低與批次 B 表格改寫的衝突面。"
```

---

### Task 16: 文件、全套驗收與 PR

**Files:**
- Modify: `README.md`、`README.zh-TW.md`（測試數徽章 + 功能條目）
- Modify: `docs/DEPLOY.md:185`（migration 範圍 0001–0005 → 0001–0006）

- [ ] **Step 1: 跑完整驗收（先看真實數字再改文件）**

```bash
cd packages/worker && pnpm test 2>&1 | tail -5
cd ../.. && pnpm -r typecheck
pnpm --filter @chippot/admin build
VITE_API_BASE=https://example.invalid pnpm --filter @chippot/web build
```
Expected: `Tests  <N> passed (<N>)`、`Test Files 47 passed`（41 + 6 個新檔）、typecheck 無輸出、兩個 build 皆 `✓ built in …`。把 `<N>` 記下來——README 徽章要用這個數字，不要用本計畫預估的 358。

- [ ] **Step 2: 更新 README 徽章與功能條目**

`README.md` 與 `README.zh-TW.md`：
1. 測試徽章的數字換成 Step 1 的 `<N>`（兩個檔都有）。
2. 功能列表補四條（中英各自對應）：
   - 審核結果會回到成員手上：退回一定 @ 當事人並附原因，確認收款可選擇是否通知。
   - `/我的帳單`：成員自助查詢待繳與最近紀錄。
   - 綁錯名字可自助解綁重綁（兩段確認、寫入稽核）。
   - 個別催繳與入職通知（CSV 匯入／新增訂閱／重新同步），皆去重、並回報 @ 不到的未綁定成員。

- [ ] **Step 3: 修掉 DEPLOY.md 的過時範圍**

`docs/DEPLOY.md:185`：「首次部署會套入 0001–0005 的初始 schema 與示範 seed」→「0001–0006」。同時確認該段仍正確描述 `pnpm deploy` 會先跑 `wrangler d1 migrations apply`（0006 是本批次唯一的 schema 變更，既有部署會在下次 deploy 自動套用）。

- [ ] **Step 4: 檢查沒有誤觸禁區**

```bash
git status --porcelain
git diff --stat origin/main...HEAD -- packages/worker/wrangler.toml docs/deploy-state.md
```
Expected: 第二個指令**無輸出**（`wrangler.toml` 與 `deploy-state.md` 完全沒被改到）。若有輸出，`git checkout origin/main -- <file>` 還原。

- [ ] **Step 5: Commit + PR**

```bash
git add README.md README.zh-TW.md docs/DEPLOY.md
git commit -m "docs: 更新測試數與成員回饋迴路的功能說明"
git push -u origin ux/45-member-feedback
gh pr create --title "[UX-C] 成員回饋迴路：審核結果回條、我的帳單、綁定出路、個別催繳" --body "$(cat <<'BODY'
Closes #45

批次 C（唯一新增對外訊息的批次）。**每一則新訊息都走 `claimNotification`**：
- `receipt` slot 以 (payment, event) 為單位——退回與確認是兩個 slot，成員重新送出或管理員撤回驗證時釋放，所以真正的再次退回會再通知、重試不會。
- `nudge` slot 以 (period, user) 為單位——自動路徑（匯入／新增訂閱／重新同步）不 force，只有管理員按下催繳才 delete-then-claim（沿用 billing.ts / scheduled.ts 既有模式）。

**投遞方式決策**：全部走帳單頻道 @，不加 DM。adapter 只有 channel API，加 DM 需要每位收件人多一次 REST 呼叫、且會多一種「對方關閉私訊」的無回饋失敗模式；系統既有的成員面訊息（開繳／催繳／入職）本來就都在那個頻道。

**含 schema 變更**：`migrations/0006_notification_event.sql` 重建 `notification_logs`（加 `event` 欄、`type` 加 `'nudge'`、UNIQUE 含 `event`）。`pnpm deploy` 會自動套用。

**範圍**：P0-5、P0-6、C1–C9。順帶修掉 healthcheck P0-8（指令描述「可選」）與成員頁金額千分位（D19 的 web 半邊）——批次 D 請跳過這兩項。

**驗收**：worker 測試 <N> passed（新增 6 個測試檔）、`pnpm -r typecheck` 綠、admin/web build 綠。`packages/admin`／`packages/web` 無測試框架（本 PR 未引入），改以結構性 grep + tsc + build + dev server 人工檢視驗收。
BODY
)"
```

- [ ] **Step 6: 回報**

把 PR 連結、最終測試數、以及兩個給後續批次的提醒（批次 D 跳過 P0-8 與 D19-web；批次 B 合併後 Task 15 需要重新 anchor 一行）寫進交付訊息。

---

## Self-Review

**Spec coverage（issue #45 逐項對照）**

| Spec 項目 | Task |
|---|---|
| P0-5 receipt 通知（退回帶原因 @ 當事人；verify 可選） | 1, 2, 3, 4 |
| P0-6 成員繳費頁英文技術錯誤中文化 | 5 |
| C1 手動／CSV 入職零通知 + nudge 未走 claim（P2-4） | 12（後端）, 13（前端） |
| C2 個別催繳 | 12（端點）, 14（按鈕） |
| C3 成員「我的帳單」 | 10 |
| C4 綁錯名字死路 | 11 |
| C5 成員 web 頁不可達 + 失效頁死路 | 8（可達）, 9（文案） |
| C6 兩套金額算法收斂 | 6 |
| C7 R2 未設定時 `/繳費` 截圖靜默丟棄 | 7 |
| C8 三入口能力差異提前告知 | 7（＋8 補上網頁那條） |
| C9 未綁定成員後台可見 | 15 |
| 硬規則：新訊息一律走 claimNotification | 1（原語）、3／4（receipt）、12（nudge）；Task 16 的 PR 內文複述 |

**型別一致性檢查**：`NotificationKey.event` / `releaseNotification` / `releaseReceiptSlots`（Task 1）→ 被 Task 3、4、12 使用，名稱一致；`ReceiptKind` / `ReceiptTarget`（Task 2）→ Task 3、4 使用；`NudgeKind` 定義在 `notify.ts`（Task 12）並同時被 adapter 與 `core/nudge.ts` 使用；`NudgeResult` 的欄位（`opened/notified/skipped/unbound/unbound_names`）在 worker（Task 12）、admin api（Task 13）、`nudgeSummary`（Task 13）、SyncModal（Task 15）四處一致；`payCommand(proofEnabled)`（Task 7）在 Task 10 的註冊陣列裡沿用同一個名字；web 的 `lines` / `PayableLine`（Task 6）在 Task 9 未被改名。

**已知的跨 task 相依**（執行順序不可任意調換）：1 → 2 → 3 → 4；7 → 8（`payChannelPrompt` 的 return 被改兩次，後者含前者）；8 → 9（失效頁文案要等網頁連結真的存在）；12 → 13 → 14 → 15（`nudgeMembers` / `nudgeSummary` / 回傳的 `unbound`）。5、6、10、11 之間彼此獨立。
