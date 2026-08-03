# UX 批次 A：危險動作與期別安全（issue #43）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓所有會「改帳單／改定價／對外廣播／關閉期別」的動作都走同一套「兩段式預覽 → 具名紅色確認 → 回報真實筆數」流程，並且沒有任何入口能在使用者不知情的情況下把期別打回未開繳。

**Architecture:** 後端把三個混在一起的能力拆開 —— `initiateBillingOpened`（開繳＝改價＋建帳單＋廣播）、新的 `resendBillingOpenedNotice`（只重貼公告，不碰資料、不清 marker）、以及 `sendOverdueForPeriod`（催繳，改為回傳結果物件而非裸數字）。三支都取得 dry-run 能力，於是前端能沿用既有 `SyncModal`／`RetractModal` 的兩段式 modal，不新增第四種樣式。前端把 `PushStatus` 拆成獨立檔、把 `ConfirmDelete` 升格成 `ui.tsx` 的共用 `ConfirmDanger`，並把 `var(--danger, #c0392b)` 這個全站唯一未定義的顏色 token 徹底刪掉，統一用 `--red`。

**Tech Stack:** TypeScript；Cloudflare Workers + D1（手寫 router，`packages/worker/src/router.ts`）；vitest + `@cloudflare/vitest-pool-workers`；React 18 + Vite hash-routing SPA（`packages/admin`）；單一手寫 stylesheet，無 CSS framework。

## Global Constraints

- **TDD，真 runtime。** worker 套件目前 **41 檔 / 300 tests 全綠**（`cd packages/worker && npx vitest run` 實測），必須維持全綠且**只增不減**（本計畫預計 +30 左右）。每個後端行為都要有對應真測試，風格照鄰近測試檔。
- **測試儲存隔離是 per-FILE**（同檔內 `it` 之間會累積、檔案結束才 rollback）。**新增測試檔前必看該檔既有 fixture id band**。目前已被佔用：`9001–9010, 9020–9032, 9040/9041, 9051, 9061, 9099, 9110–9112, 9200–9250, 9298–9304, 9310, 9400–9432, 9490, 9500–9543, 9599, 9700/9701, 9710, 9999`。**本計畫一律使用 98xx（全新未使用），每個新檔一個 band。**
- **admin 套件沒有前端測試框架，不要發明一個。** 它的 gate 是 `pnpm --filter @chippot/admin typecheck`＋`pnpm --filter @chippot/admin build`，加上 Task 13 的 Chrome DevTools（CDP）人工驗收證據。
- `pnpm -r typecheck` 必須全綠。
- **絕對不要碰 `packages/worker/wrangler.toml`。**
- `.superpowers/deploy-state.md` 是 gitignore 的本機檔，**不要 commit、不要新增 commit 步驟**。
- Conventional commits，subject 可用 zh-TW。**所有使用者可見文案一律 zh-TW。**
- 分支：`ux/43-danger-actions`。PR body 用 zh-TW，必須包含 `Closes #43`。
- **新增的使用者可見錯誤訊息一律寫 zh-TW**（`routes/upload.ts:57` 已有先例）。既有英文訊息的全面中文化屬於批次 D，本批次不做。

## Don't-break list（改 A 時別壞 B）

改動任何一行前先確認這幾件事在收工時仍然成立：

1. **兩段式 modal 模式**（`SyncModal`／`RetractModal`／`ImportModal`）—— 本批次是把更多動作**拉進**這個模式，不是另創第四種。
2. **>25 人名單的降級策略**（`handler.ts:306-366` autocomplete＋搜尋 modal）不得受影響。
3. **R2 未設定時的降級文案**在三個 surface 一致（`App.tsx:19`、`Payments.tsx:49`、`web/App.tsx:126`、`handler.ts:209`）—— 不要動。
4. **通知測試送出**（`Settings.tsx:269` `TestButton`）是全專案唯一誠實回報成功／失敗的外送動作 —— 它是 A1 的**模板**，照抄它的形狀，不要改它。
5. **MemberReview 的動態按鈕標籤**（`MemberReview.tsx:91-93`）不要動。
6. **零橫向溢出**：51 個 admin 場景 × 寬度組合皆 `scrollWidth === clientWidth`。新 modal 內容不得破壞這點（Task 13 會量）。

## File Structure

**Worker（`packages/worker`）**

| 檔案 | 本計畫後的責任 |
|---|---|
| `src/core/billing.ts` | 開繳／同步／收回的核心。**新增** `resendBillingOpenedNotice()`（只重貼公告）與 `previewBillingInitiate()`（dry-run 影響預覽）；`initiateBillingOpened` **移除** `opts.force`、**新增** `createdPayments` 回傳、reprice 的 UPDATE 加 `AND amount != ?`；私有 `isPeriodOpened` 改成 `isBillingOpened` 的薄包裝（同一句 SQL，去重）。 |
| `src/core/scheduled.ts` | 每日 cron ＋ `sendOverdueForPeriod`。**改**回傳型別為 `OverdueResult` 物件（含 `outcome`／`people`／`overdue_days`），**新增** `dryRun` 選項。 |
| `src/routes/admin.ts` | admin REST。`notificationsResend` 改走新的 resend 函式＋支援 `dry_run`（預設 true）＋未開繳 409；`notificationsReset` 對 `billing_opened` 回 409；`billingInitiate` 支援 `dry_run`（預設 true）；`createUploadLink` 驗 period 格式；`discordRegisterCommands` 寫入註冊時間。 |
| `src/routes/upload.ts` | 成員 web 繳費。**新增**開繳閘門（未開繳 409，zh-TW）。 |
| `src/env.ts` | `WorkspaceSettings` **新增** `discord_commands_registered_at: string`。 |
| `src/adapters/discord/handler.ts` | `handleInitiateCommand` **新增** `期別` option、預設值改 `periodForBillingDay`、方案 >5 直接拒絕；`deferredInitiate` 文案帶期別。 |
| `src/adapters/discord/commands.ts` | `INITIATE_COMMAND` **新增** `期別` option、description 去掉「本期」。 |
| `test/core/billing-resend.test.ts` | **新檔**，band **9800**。resend 只重貼、不建帳單、不清 marker。 |
| `test/core/overdue-preview.test.ts` | **新檔**，band **9810**。overdue dry-run 與 outcome 分類。 |
| `test/routes/notifications-danger.test.ts` | **新檔**，band **9820**。resend/reset 的 409 閘門與誠實回報。 |
| `test/core/billing-initiate-preview.test.ts` | **新檔**，band **9830**。initiate dry-run 不寫入、數字與 apply 對得上。 |
| `test/routes/upload-gate.test.ts` | **新檔**，band **9840**。web token 開繳閘門＋upload-link period 驗證。 |
| `test/adapters/discord-initiate-cap.test.ts` | **新檔**，band **9850**。>5 方案拒絕。 |
| `test/core/scheduled.test.ts` | **改**：一處 `count` → `.notified`。 |
| `test/routes/admin.test.ts` | **改**：resend/reset/initiate 呼叫補 `dry_run: false`；註冊指令多驗一個時間戳。 |
| `test/adapters/discord-initiate.test.ts` | **改**：預期期別改 `periodForBillingDay(5)`；新增帶 `期別` option 的案例。 |
| `test/core/billing-initiate.test.ts` | **改**：`force` 測試改寫為「已開繳期別再次 initiate 不重複發送」。 |

**Admin SPA（`packages/admin`）**

| 檔案 | 本計畫後的責任 |
|---|---|
| `src/ui.tsx` | **新增** `ConfirmDanger`（從 `Manage.tsx` 的 `ConfirmDelete` 升格，改用 `btn--danger`、可自訂確認字樣）。 |
| `src/api.ts` | **新增** resend/initiate 的 preview 型別與 `dry_run` 參數；**新增** `NOTIFY_REASON_TEXT`／`OVERDUE_OUTCOME_TEXT` 中文對照。 |
| `src/views/PushStatus.tsx` | **新檔**（自 `Dashboard.tsx` 抽出）。推播狀態表＋兩個兩段式 modal＋一個 confirm modal。 |
| `src/views/Dashboard.tsx` | **縮小**：只留期別工具列、統計卡、各方案表、渠道表，`PushStatus` 改 import。 |
| `src/views/Settings.tsx` | `InitiateModal` 改兩段式；預設期別改 `periodForBillingDay`；「預開下期」變明確次要選項；CSV 匯入觸發鈕去紅；三個「立即執行」顯示持久狀態。 |
| `src/views/Payments.tsx` | 收回 tooltip 與 `RetractModal` 內文補「已退回」「上傳連結失效」。 |
| `src/views/Manage.tsx` | `ConfirmDelete` 刪除（改用 `ui.tsx` 的 `ConfirmDanger`）；四張表的「刪除」改 `btn--danger`；「解除綁定」的 `window.confirm` 改 modal。 |
| `src/views/PaymentDetail.tsx` | 「刪除此筆」的 `window.confirm` 改 `ConfirmDanger`。 |
| `src/styles.css` | `.btn--danger` 旁加一段規則註解；**不新增顏色 token**（`--danger` 從此不再被任何檔案引用）。 |

不動：`packages/web`、任何 migration、`wrangler.toml`。

## Design decisions（動手前先讀）

1. **P0-1 採 owner 決策的行為分離。** `overdue` 的重置**保留**、改名「重置催繳發送紀錄」、加 confirm modal（它真的只是刪一列去重紀錄，無副作用）。`billing_opened` 的重置**從 UI 移除**，後端 `POST /admin/notifications/reset` 收到 `type: "billing_opened"` 一律 **409**，訊息指向「收回本期開繳」。理由：那半套動作沒有任何正確使用情境 —— 它讓期別讀起來未開繳、帳單卻全留著，對帳看板照樣算應收。

2. **P0-2(a) 選 409，不選預覽。** team lead 要求「挑比較簡單、能真正拆掉地雷的那個」。但只加 409 還不夠：即使期別已開繳，舊實作的 `force` 路徑仍會對所有 active 訂閱跑 `ensurePeriodPayment`（幫後來加入的人建帳單）並且**先刪 marker 再 claim**（中間有一段時間期別讀起來是未開繳）。所以本計畫另寫 `resendBillingOpenedNotice`：**只重貼公告**，用 `UPDATE notification_logs SET sent_at = ?` 更新時間戳而非 delete+claim，於是**重發過程中期別永遠不會短暫變成未開繳**。公告名單直接沿用 cron 的那句 SQL，「立即重發」與 cron 從此列出同一份名單。

3. **`initiateBillingOpened` 的 `opts.force` 整個移除。** 移除後 `src/` 內零呼叫者。這是刻意刪掉一個「有測試覆蓋」的能力：它唯一的行為就是製造上面那段「期別短暫未開繳」的窗口，留著等於給下一個呼叫者一把上膛的槍。PR body 必須明講這件事。

4. **P0-3 選「拒絕並指向後台」。** 方案 >5 時 `/發起繳費` 直接回 ephemeral 拒絕。理由：「列出被略過的方案」仍然讓管理員以為自己確認了全部金額，而公告會用舊價印出第 6 個以後的方案 —— 半套確認才是地雷本身。Web 版無此上限，是完整替代路徑。

5. **兩個 surface 的預設期別統一為 `periodForBillingDay`（目前收款中的期別）。** 這是 `billing_day = 1` 那個 bug 的根因（`nextBillingPeriod` 在 2 號到月底都指向下個月）。`nextBillingPeriod` 不刪 —— 它改為「預開下期」這個明確次要選項的計算來源。

6. **A2 的「立即重發」改名為「催繳未繳成員…」並補預覽。** 不改 `force` 的語意（管理員確實需要「不管逾期天數，全部 @ 一次」），改成在預覽裡把差異講白：「這會 @ 本期**所有**未繳成員（N 位），不受『逾期天數（{d} 天）』限制；每日自動催繳只會 @ 已超過逾期天數的人。」誠實 > 閹割功能。

7. **A4 只用一種紅：`--red`，一種按鈕：`btn--danger`。** 不新增 `--danger`、不新增實心紅按鈕 class。確認鍵一律 `btn btn--danger`（與既有 `RetractModal` 的「確認收回」一致）。`window.confirm` 全部淘汰。CSV 匯入觸發鈕**去紅**（它是可逆、preview-first 的動作，紅色語意反了）；`發起繳費` 觸發鈕**保持紅**（改價＋對外廣播）。

8. **A6 三個「立即執行」都顯示持久狀態。** 前兩個（常駐訊息、綁定按鈕）的 message id 已存在 settings，純前端即可。第三個（註冊指令）沒有任何持久標記，因此在 `WorkspaceSettings` 新增 `discord_commands_registered_at`，由 `discordRegisterCommands` 用既有的 `json_set` 寫法寫入 —— 5 行，不值得為了少 5 行而讓 A6 只做三分之二。

9. **A7 留在批次內，沒有 descope。** 加一個 optional `期別` string option ＋ `PERIOD_RE` 驗證，約 10 行加一個測試。

10. **`initiateBillingOpened` 的 reprice UPDATE 加 `AND amount != ?`。** SQLite 的 `changes()` 會把「值沒變的 UPDATE」也算進去，導致預覽的 `reprice.length` 與套用後的 `updated_payments` 對不上、看起來像 bug。加上這個條件後兩個數字精確相等。

---

### Task 1: `resendBillingOpenedNotice` —— 只重貼公告，不碰任何資料

**Files:**
- Modify: `packages/worker/src/core/billing.ts`
- Test: `packages/worker/test/core/billing-resend.test.ts`（**新檔，fixture band 9800**）

**Interfaces:**
- Consumes: `isBillingOpened(db, workspaceId, period)`（`src/core/notify.ts`，已存在）、`Notifier`、`PlanOpenLine`、`parseSettings`、`nowUtcIso`。
- Produces:
  ```ts
  export type ResendOutcome = "sent" | "preview" | "not_opened" | "no_channel" | "no_bot_token" | "no_plans";
  export interface ResendBillingResult { outcome: ResendOutcome; sent: boolean; lines: PlanOpenLine[] }
  export function resendBillingOpenedNotice(
    env: Env, workspaceId: number, period: string, notifier: Notifier, opts: { dryRun: boolean }
  ): Promise<ResendBillingResult>
  ```
  Task 3（route）與 Task 9（前端）依賴這個型別。

- [ ] **Step 1: 寫失敗的測試**

建立 `packages/worker/test/core/billing-resend.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resendBillingOpenedNotice } from "../../src/core/billing";
import { claimNotification, type Notifier, type PlanOpenLine } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9800;
const PLAN = 9800, PLAN_OFF = 98001;
const SUB = 9800;
const USER = 9800, USER_LATE = 98001;
const CHAN = "chan-9800";
const OPENED = "2027-03";   // 有 billing_opened 紀錄
const UNOPENED = "2027-04"; // 沒有

const sent: { period: string; lines: PlanOpenLine[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened(_e, _ch, period, lines, _t) { sent.push({ period, lines }); },
  async sendOverdue() {},
  async sendPaymentNudge() {},
};

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_LATE, WS, "Late", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, "role-a", TS, TS),
    // 停用的方案不該出現在公告名單裡
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,discord_role_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(PLAN_OFF, WS, "Off", "openai", 100, null, 0, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2027-03-01", 1, TS, TS),
  ]);
  await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: OPENED });
});

describe("resendBillingOpenedNotice", () => {
  it("拒絕未開繳的期別，且不發送任何訊息", async () => {
    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, UNOPENED, notifier, { dryRun: false });
    expect(r.outcome).toBe("not_opened");
    expect(r.sent).toBe(false);
    expect(sent.length).toBe(before);
  });

  it("dry run 回傳公告名單但不發送", async () => {
    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: true });
    expect(r.outcome).toBe("preview");
    expect(r.sent).toBe(false);
    expect(r.lines.map((l) => l.plan_name)).toEqual(["ChatGPT"]); // 停用方案不入列
    expect(sent.length).toBe(before);
  });

  it("重發會送出訊息、更新 sent_at，且 marker 全程存在", async () => {
    const before = sent.length;
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    expect(r.outcome).toBe("sent");
    expect(r.sent).toBe(true);
    expect(sent.length).toBe(before + 1);
    // 期別仍然只有一列 billing_opened，且 sent_at 已更新（不是 delete + re-insert）
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_logs WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?"
    ).bind(WS, OPENED).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("重發不會為後來加入的成員建立帳單", async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(98002, WS, USER_LATE, PLAN, "2027-03-01", 1, TS, TS).run();
    await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE workspace_id = ? AND period = ?"
    ).bind(WS, OPENED).first<{ n: number }>();
    expect(n!.n).toBe(0); // 重發只是重貼公告
  });

  it("沒有頻道設定時回報 no_channel 而不是假成功", async () => {
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?").bind(JSON.stringify({}), WS).run();
    const r = await resendBillingOpenedNotice(env, WS, OPENED, notifier, { dryRun: false });
    expect(r).toMatchObject({ outcome: "no_channel", sent: false });
    await env.DB.prepare("UPDATE workspaces SET settings = ? WHERE id = ?").bind(JSON.stringify({ discord_billing_channel_id: CHAN }), WS).run();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/core/billing-resend.test.ts`
Expected: FAIL —— `resendBillingOpenedNotice is not a function` / import 解析不到。

- [ ] **Step 3: 實作**

在 `packages/worker/src/core/billing.ts`：先把 import 從 `./notify` 補上 `isBillingOpened`：

```ts
import { claimNotification, isBillingOpened, type Notifier, type PlanOpenLine } from "./notify";
```

把私有的 `isPeriodOpened`（原 `billing.ts:241-247`）整段替換成薄包裝，消掉重複的 SQL：

```ts
/** A period is "opened" once its billing_opened notice has been claimed — that is what members can pay against. */
function isPeriodOpened(env: Env, workspaceId: number, period: string): Promise<boolean> {
  return isBillingOpened(env.DB, workspaceId, period);
}
```

在 `initiateBillingOpened` 之後（`billing.ts:217` 那個 `}` 下方）新增：

```ts
// ── "立即重發開繳通知" (re-post the notice only — never touches bills or prices) ──

export type ResendOutcome = "sent" | "preview" | "not_opened" | "no_channel" | "no_bot_token" | "no_plans";

export interface ResendBillingResult {
  outcome: ResendOutcome;
  sent: boolean;
  /** The plan lines the notice does / would list. */
  lines: PlanOpenLine[];
}

/**
 * Re-post an ALREADY-OPENED period's billing-opened notice. Unlike initiateBillingOpened this
 * writes no prices and creates no bills — "重發" means exactly what it says.
 *
 * The dedup slot is REFRESHED with an UPDATE rather than deleted-then-reclaimed, so the period is
 * never momentarily readable as "unopened": members' pay button, reconcile and retract all key off
 * that single row, and a delete-then-claim window would make a resend look like a half retract.
 *
 * The plan lines come from the SAME query the cron uses (scheduled.ts step 2), so the admin resend
 * and the automatic notice can never list a different set of plans.
 */
export async function resendBillingOpenedNotice(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { dryRun: boolean }
): Promise<ResendBillingResult> {
  const bare = (outcome: ResendOutcome): ResendBillingResult => ({ outcome, sent: false, lines: [] });

  if (!(await isBillingOpened(env.DB, workspaceId, period))) return bare("not_opened");
  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return bare("not_opened");
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return bare("no_channel");
  if (!env.DISCORD_BOT_TOKEN) return bare("no_bot_token");

  const lines = (await env.DB
    .prepare(
      `SELECT pl.id AS plan_id, pl.name AS plan_name, pl.monthly_amount AS amount, pl.discord_role_id AS role_id
       FROM plans pl
       WHERE pl.workspace_id = ? AND pl.active = 1
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = pl.id AND s.status = 'active')
       ORDER BY pl.id`
    )
    .bind(workspaceId)
    .all<PlanOpenLine>()).results;
  if (lines.length === 0) return { outcome: "no_plans", sent: false, lines };
  if (opts.dryRun) return { outcome: "preview", sent: false, lines };

  await notifier.sendBillingOpened(env, channelId, period, lines, settings.billing_opened_template);
  await env.DB
    .prepare("UPDATE notification_logs SET sent_at = ? WHERE workspace_id = ? AND type = 'billing_opened' AND period = ?")
    .bind(nowUtcIso(), workspaceId, period)
    .run();
  return { outcome: "sent", sent: true, lines };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/core/billing-resend.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 跑全套確認沒有連帶災情**

Run: `cd packages/worker && npx vitest run`
Expected: 41+1 檔全綠、305 tests。

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/core/billing.ts packages/worker/test/core/billing-resend.test.ts
git commit -m "feat(worker): 新增 resendBillingOpenedNotice（只重貼開繳公告，不建帳單、不清 marker）"
```

---

### Task 2: `initiateBillingOpened` 移除 `force`、回報建立筆數、精確 reprice

**Files:**
- Modify: `packages/worker/src/core/billing.ts:110-217`
- Modify: `packages/worker/test/core/billing-initiate.test.ts:66-74`

**Interfaces:**
- Produces:
  ```ts
  export interface InitiateResult {
    sent: boolean; updatedPlans: number; createdPayments: number; updatedPayments: number;
  }
  export function initiateBillingOpened(
    env: Env, workspaceId: number, period: string, input: InitiateInput, actor: string, notifier: Notifier
  ): Promise<InitiateResult>   // ← 第 7 個參數 opts 已移除
  ```
  Task 4（preview）、Task 3（route）、Task 6（Discord handler）依賴這個簽章。

- [ ] **Step 1: 改寫既有的 force 測試（先讓它失敗）**

把 `packages/worker/test/core/billing-initiate.test.ts:66-74` 那個 `it("force re-sends...")` 整段換成：

```ts
  it("已開繳的期別再次 initiate 只改金額、不重複發送通知", async () => {
    await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
    const before = sent.length;
    const r2 = await initiateBillingOpened(env, WS, "2027-07", { amounts: [] }, "owner@x", notifier);
    expect(r2.sent).toBe(false);
    expect(sent.length).toBe(before); // 沒有第二則公告
  });

  it("回報真實的建立筆數：第一次建帳單，第二次是 0", async () => {
    const first = await initiateBillingOpened(env, WS, "2027-08", { amounts: [] }, "owner@x", notifier);
    expect(first.createdPayments).toBe(2); // SUB_A + SUB_B
    const again = await initiateBillingOpened(env, WS, "2027-08", { amounts: [] }, "owner@x", notifier);
    expect(again.createdPayments).toBe(0);
  });

  it("金額沒變時 updatedPayments 不灌水", async () => {
    // 2027-08 的 pending 帳單此時已是 PLAN_B 的現價（前一個測試建立）
    const same = await initiateBillingOpened(
      env, WS, "2027-08", { amounts: [{ plan_id: PLAN_B, amount: 300 }] }, "owner@x", notifier
    );
    expect(same.updatedPayments).toBe(0);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/core/billing-initiate.test.ts`
Expected: FAIL —— `createdPayments` 是 `undefined`；「金額沒變」那個會拿到 1。

- [ ] **Step 3: 實作**

在 `packages/worker/src/core/billing.ts`：

改 `InitiateResult`（原 `:114-118`）：

```ts
export interface InitiateResult {
  sent: boolean;
  updatedPlans: number;
  /** Bills this call actually created for the period (0 on a re-run — the insert is idempotent). */
  createdPayments: number;
  /** PENDING bills whose amount really changed (no-op rewrites are not counted). */
  updatedPayments: number;
}
```

改函式簽章（原 `:127-135`）—— 刪掉 `opts` 參數：

```ts
export async function initiateBillingOpened(
  env: Env,
  workspaceId: number,
  period: string,
  input: InitiateInput,
  actor: string,
  notifier: Notifier
): Promise<InitiateResult> {
```

改計數宣告（原 `:144-145`）：

```ts
  let updatedPlans = 0;
  let createdPayments = 0;
  let updatedPayments = 0;
```

改建帳單迴圈（原 `:169`）：

```ts
  for (const s of subs.results) {
    const r = await ensurePeriodPayment(env.DB, s.id, period);
    if (r.created) createdPayments++;
  }
```

改 reprice 的 UPDATE（原 `:170-180`）—— 加上 `AND amount != ?`，讓 `changes()` 等於真正的變更數：

```ts
  for (const [planId, amount] of amountByPlan) {
    const res = await env.DB
      .prepare(
        `UPDATE payments SET amount = ?, updated_at = ?
         WHERE workspace_id = ? AND period = ? AND status = 'pending' AND amount != ?
           AND subscription_id IN (SELECT id FROM subscriptions WHERE workspace_id = ? AND plan_id = ? AND status = 'active')`
      )
      .bind(amount, now, workspaceId, period, amount, workspaceId, planId)
      .run();
    updatedPayments += res.meta.changes ?? 0;
  }
```

刪掉整個 force 分支（原 `:188-194`），讓通知段落變成：

```ts
  let sent = false;
  if (channelId && env.DISCORD_BOT_TOKEN) {
    if (await claimNotification(env.DB, { workspaceId, type: "billing_opened", period })) {
```

（後面 `lines` 的組法與 `if (lines.length > 0)` 一段完全不動。）

改 audit 與 return（原 `:211-216`）：

```ts
  await writeAudit(env.DB, {
    workspaceId, actor, action: "billing.initiate", entityType: "workspace", entityId: workspaceId,
    after: { period, updatedPlans, createdPayments, updatedPayments, sent },
  });

  return { sent, updatedPlans, createdPayments, updatedPayments };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/core/billing-initiate.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 修好 `force` 消失造成的型別錯誤**

`src/routes/admin.ts:201` 仍在傳 `{ force: true }`，這時候 `tsc` 會抱怨。這一步先做**最小的暫時修補**（Task 3 會把整支 handler 重寫）：把 `admin.ts:201` 改成

```ts
    const r = await resendBillingOpenedNotice(env, ws, period, discordNotifier, { dryRun: false });
    result = { sent: r.sent };
```

並在 `admin.ts:9` 的 import 補上 `resendBillingOpenedNotice`：

```ts
import { ensureFirstPayment, initiateBillingOpened, reconcilePeriodBills, retractPeriodBilling, resendBillingOpenedNotice } from "../core/billing";
```

Run: `cd packages/worker && npx tsc --noEmit`
Expected: 無輸出。

- [ ] **Step 6: 跑全套 + commit**

Run: `cd packages/worker && npx vitest run` → 全綠。

```bash
git add packages/worker/src/core/billing.ts packages/worker/src/routes/admin.ts packages/worker/test/core/billing-initiate.test.ts
git commit -m "refactor(worker)!: initiateBillingOpened 移除 force、回報 createdPayments、reprice 不灌水"
```

---

### Task 3: `sendOverdueForPeriod` 回傳結果物件並支援 dry-run

**Files:**
- Modify: `packages/worker/src/core/scheduled.ts:80`（cron 呼叫點）、`:91-153`（函式本體）
- Modify: `packages/worker/src/routes/admin.ts:204`
- Modify: `packages/worker/test/core/scheduled.test.ts:87-88`
- Test: `packages/worker/test/core/overdue-preview.test.ts`（**新檔，fixture band 9810**）

**Interfaces:**
- Consumes: `OverduePerson`（`src/core/notify.ts`）。
- Produces:
  ```ts
  export type OverdueOutcome = "sent" | "preview" | "no_channel" | "no_bot_token" | "none_due" | "already_sent";
  export interface OverdueResult {
    notified: number;            // 真正送出的人數（dry run 一律 0）
    outcome: OverdueOutcome;
    overdue_days: number;        // workspace 設定值，供 UI 把差異講清楚
    people: OverduePerson[];     // 會被 @ 的人（dry run 用來預覽）
  }
  export function sendOverdueForPeriod(
    env: Env, workspaceId: number, period: string, notifier: Notifier,
    opts: { force: boolean; dryRun?: boolean; now?: Date }
  ): Promise<OverdueResult>
  ```

- [ ] **Step 1: 寫失敗的測試**

建立 `packages/worker/test/core/overdue-preview.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sendOverdueForPeriod } from "../../src/core/scheduled";
import type { Notifier, OverduePerson } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9810;
const PLAN = 9810;
const USER_A = 9810, USER_B = 98101;
const SUB_A = 9810, SUB_B = 98101;
const CHAN = "chan-9810";
const PERIOD = "2098-06";
const EMPTY_PERIOD = "2098-07";

const sent: { people: OverduePerson[] }[] = [];
const notifier: Notifier = {
  async sendBillingOpened() {},
  async sendOverdue(_e, _ch, _p, people, _t) { sent.push({ people }); },
  async sendPaymentNudge() {},
};

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN, overdue_days: 3 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER_A, WS, "d-9810a", "A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER_B, WS, "d-9810b", "B", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER_A, PLAN, "2098-06-01", 1, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER_B, PLAN, "2098-06-01", 1, TS, TS),
    // 兩張未繳帳單，due_date 在未來 → 都還沒超過 overdue_days
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_A, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 315, "pending", "cron", TS, TS),
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 315, "pending", "cron", TS, TS),
  ]);
});

describe("sendOverdueForPeriod 結果物件", () => {
  it("dry run 列出會被 @ 的人、不送出、並帶回 overdue_days", async () => {
    const before = sent.length;
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    expect(r.outcome).toBe("preview");
    expect(r.notified).toBe(0);
    expect(r.overdue_days).toBe(3);
    expect(r.people.map((p) => p.user_name).sort()).toEqual(["A", "B"]);
    expect(sent.length).toBe(before);
  });

  it("沒有未繳帳單的期別回 none_due", async () => {
    const r = await sendOverdueForPeriod(env, WS, EMPTY_PERIOD, notifier, { force: true, dryRun: true });
    expect(r).toMatchObject({ outcome: "none_due", notified: 0 });
    expect(r.people).toEqual([]);
  });

  it("force=false 時未到逾期天數的人不會被列入（cron 名單）", async () => {
    // due_date 是 2098-06-01、overdue_days=3 → 用 2098-06-02 當今天，還沒逾期
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, {
      force: false, dryRun: true, now: new Date("2098-06-02T00:00:00Z"),
    });
    expect(r).toMatchObject({ outcome: "none_due", notified: 0 });
  });

  it("實際送出後回報真實人數", async () => {
    const before = sent.length;
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: false });
    expect(r).toMatchObject({ outcome: "sent", notified: 2 });
    expect(sent.length).toBe(before + 1);
  });

  it("沒有 bot token 時回 no_bot_token 而不是假成功", async () => {
    const prev = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "";
    const r = await sendOverdueForPeriod(env, WS, PERIOD, notifier, { force: true, dryRun: true });
    expect(r).toMatchObject({ outcome: "no_bot_token", notified: 0 });
    (env as any).DISCORD_BOT_TOKEN = prev;
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/core/overdue-preview.test.ts`
Expected: FAIL —— 回傳是 number，`r.outcome` 是 `undefined`。

- [ ] **Step 3: 實作**

在 `packages/worker/src/core/scheduled.ts`，把 `sendOverdueForPeriod`（`:91-153`）整段替換：

```ts
export type OverdueOutcome = "sent" | "preview" | "no_channel" | "no_bot_token" | "none_due" | "already_sent";

export interface OverdueResult {
  /** People actually messaged. Always 0 on a dry run — use `people.length` for the preview count. */
  notified: number;
  outcome: OverdueOutcome;
  /** The workspace's 逾期天數, so callers can spell out how force differs from the cron. */
  overdue_days: number;
  people: OverduePerson[];
}

/**
 * Send the overdue reminder for ONE period as a single batched public message listing every
 * unpaid member — pending OR rejected (a rejected submission still owes) — tagged once with
 * their plans + total, deduped per (ws, period).
 *
 * force=false (cron): only fires when ≥1 member is past overdue_days; claim-then-send.
 * force=true (admin "催繳未繳成員"): lists ALL unpaid members regardless of overdue_days and clears
 * the dedup slot first so it always re-sends. The two lists genuinely differ, which is why the UI
 * must not call both "立即重發" — see the copy in views/PushStatus.tsx.
 * dryRun: compute the list and stop. Nothing is cleared, claimed or sent.
 */
export async function sendOverdueForPeriod(
  env: Env,
  workspaceId: number,
  period: string,
  notifier: Notifier,
  opts: { force: boolean; dryRun?: boolean; now?: Date }
): Promise<OverdueResult> {
  const bare = (outcome: OverdueOutcome, overdueDays = 0): OverdueResult =>
    ({ notified: 0, outcome, overdue_days: overdueDays, people: [] });

  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  if (!wsRow) return bare("no_channel");
  const settings = parseSettings(wsRow.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return bare("no_channel", settings.overdue_days);
  if (!env.DISCORD_BOT_TOKEN) return bare("no_bot_token", settings.overdue_days);
  const today = taipeiDate(opts.now ?? new Date());

  const rows = await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.discord_id AS discord_id, u.display_name AS user_name,
              p.amount AS amount, p.due_date AS due_date, pl.name AS plan_name
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN users u ON u.id = s.user_id
       JOIN plans pl ON pl.id = s.plan_id
       WHERE p.workspace_id = ? AND p.period = ? AND p.status IN ('pending','rejected')
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
  if (people.length === 0) return bare("none_due", settings.overdue_days);
  if (opts.dryRun) return { notified: 0, outcome: "preview", overdue_days: settings.overdue_days, people };

  if (opts.force) {
    // force = admin resend: clear the slot so the claim below always wins. This delete-then-claim
    // isn't atomic, but force is an occasional single-admin dashboard action whose button is
    // disabled while in flight; the only risk is a duplicate message from two truly-concurrent
    // resends, which we accept (no DO/lock — YAGNI). Unlike the billing_opened slot, the overdue
    // row carries no "period is open" meaning, so a momentary gap is harmless.
    await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = 'overdue' AND period = ?")
      .bind(workspaceId, period).run();
  }
  if (!(await claimNotification(env.DB, { workspaceId, type: "overdue", period }))) {
    return { notified: 0, outcome: "already_sent", overdue_days: settings.overdue_days, people };
  }
  await notifier.sendOverdue(env, channelId, period, people, settings.overdue_template);
  return { notified: people.length, outcome: "sent", overdue_days: settings.overdue_days, people };
}
```

改 cron 呼叫點（`scheduled.ts:80`）：

```ts
        if ((await sendOverdueForPeriod(env, ws.id, pd, notifier, { force: false, now })).notified > 0) summary.overdueSent++;
```

改 `src/routes/admin.ts:204`：

```ts
    const r = await sendOverdueForPeriod(env, ws, period, discordNotifier, { force: true });
    result = { count: r.notified };
```

- [ ] **Step 4: 修既有測試**

`packages/worker/test/core/scheduled.test.ts:87-88` 改成：

```ts
    const r = await sendOverdueForPeriod(env, WS, "2099-01", notifier, { force: true });
    expect(r.notified).toBe(1);
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/core/overdue-preview.test.ts test/core/scheduled.test.ts`
Expected: PASS

- [ ] **Step 6: 全套 + typecheck + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
```

```bash
git add packages/worker/src/core/scheduled.ts packages/worker/src/routes/admin.ts packages/worker/test/core/overdue-preview.test.ts packages/worker/test/core/scheduled.test.ts
git commit -m "refactor(worker)!: sendOverdueForPeriod 改回傳 OverdueResult 並支援 dry-run"
```

---

### Task 4: 通知 route —— resend 的 409 閘門、reset 拒收 billing_opened、誠實回報

**Files:**
- Modify: `packages/worker/src/routes/admin.ts:194-228`（`notificationsResend`／`notificationsReset`）
- Modify: `packages/worker/test/routes/admin.test.ts:215-232`
- Test: `packages/worker/test/routes/notifications-danger.test.ts`（**新檔，fixture band 9820**）

**Interfaces:**
- Consumes: `resendBillingOpenedNotice`（Task 1）、`sendOverdueForPeriod` → `OverdueResult`（Task 3）。
- Produces（Task 9 前端依賴這些 response 形狀）：
  - `POST /admin/notifications/resend`，body `{ type, period, dry_run? }`，`dry_run` **預設 true**（與 `/sync`、`/retract` 一致）。
    - `type: "billing_opened"`：未開繳 → **409** `{ error: "…" }`；否則 `{ ok: true, dry_run, outcome, sent, lines }`。
    - `type: "overdue"`：`{ ok: true, dry_run, outcome, count, overdue_days, people: [{ user_id, user_name, discord_id, total }] }`。
  - `POST /admin/notifications/reset`，`type: "billing_opened"` → **409**；`type: "overdue"` → `{ ok: true, deleted }`。

- [ ] **Step 1: 寫失敗的測試**

建立 `packages/worker/test/routes/notifications-danger.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";
import { claimNotification } from "../../src/core/notify";

const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

// 這些 route 都作用在 DEFAULT_WORKSPACE_ID = 1（seed 的 workspace）。本檔只碰它的
// notification_logs 與 2097-xx 期別，不建立自己的 workspace fixture。
const OPENED = "2097-01";
const UNOPENED = "2097-02";

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  await call("PATCH", "/admin/workspace", { settings: { discord_billing_channel_id: "chan-9820" } });
  await claimNotification(env.DB, { workspaceId: 1, type: "billing_opened", period: OPENED });
});

describe("POST /admin/notifications/resend", () => {
  it("未開繳的期別回 409 並指向發起繳費", async () => {
    const r = await call("POST", "/admin/notifications/resend", { type: "billing_opened", period: UNOPENED, dry_run: false });
    expect(r!.status).toBe(409);
    expect(((await r!.json()) as any).error).toContain("發起繳費");
  });

  it("預設是 dry run：回傳公告名單但不發送", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const r = await call("POST", "/admin/notifications/resend", { type: "billing_opened", period: OPENED });
    vi.unstubAllGlobals();
    expect(r!.status).toBe(200);
    const b = (await r!.json()) as any;
    expect(b.dry_run).toBe(true);
    expect(b.sent).toBe(false);
    expect(b.outcome).toBe("preview");
    expect(Array.isArray(b.lines)).toBe(true);
  });

  it("overdue 的 dry run 回傳名單與 overdue_days", async () => {
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: OPENED });
    expect(r!.status).toBe(200);
    const b = (await r!.json()) as any;
    expect(b.dry_run).toBe(true);
    expect(typeof b.overdue_days).toBe("number");
    expect(Array.isArray(b.people)).toBe(true);
  });
});

describe("POST /admin/notifications/reset", () => {
  it("拒絕重置 billing_opened，並指向收回本期開繳", async () => {
    const r = await call("POST", "/admin/notifications/reset", { type: "billing_opened", period: OPENED });
    expect(r!.status).toBe(409);
    expect(((await r!.json()) as any).error).toContain("收回本期開繳");
    // marker 必須還在 —— 這正是這個 409 要保護的東西
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM notification_logs WHERE workspace_id = 1 AND type = 'billing_opened' AND period = ?"
    ).bind(OPENED).first<{ ok: number }>();
    expect(row).toBeTruthy();
  });

  it("overdue 的重置照常運作", async () => {
    await claimNotification(env.DB, { workspaceId: 1, type: "overdue", period: OPENED });
    const r = await call("POST", "/admin/notifications/reset", { type: "overdue", period: OPENED });
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as any).deleted).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/routes/notifications-danger.test.ts`
Expected: FAIL —— reset 回 200 而不是 409；resend 沒有 `dry_run` 欄位。

- [ ] **Step 3: 實作**

`packages/worker/src/routes/admin.ts`，把 `notificationsResend` 與 `notificationsReset`（`:194-228`）整段替換：

```ts
async function notificationsResend(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string; dry_run?: boolean }>(req);
  if (b?.period !== undefined && typeof b.period !== "string") return errorResponse(400, "period must be YYYY-MM");
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  const dryRun = b.dry_run !== false; // safe default: preview unless explicitly false — matches /sync and /retract

  if (b.type === "billing_opened") {
    const r = await resendBillingOpenedNotice(env, ws, period, discordNotifier, { dryRun });
    // Resend re-posts an existing notice. A period with no billing_opened record has nothing to
    // re-post, and the old implementation quietly OPENED it (creating every bill + broadcasting).
    if (r.outcome === "not_opened") {
      return errorResponse(409, `${period} 尚未開繳，沒有可以重發的開繳通知。請改用「設定 → 工具 → 發起繳費」。`);
    }
    if (!dryRun) {
      await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.resend", entityType: "workspace", entityId: ws, after: { type: b.type, period, outcome: r.outcome, sent: r.sent } });
    }
    return json({ ok: true, dry_run: dryRun, outcome: r.outcome, sent: r.sent, lines: r.lines });
  }

  const r = await sendOverdueForPeriod(env, ws, period, discordNotifier, { force: true, dryRun });
  if (!dryRun) {
    await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.resend", entityType: "workspace", entityId: ws, after: { type: b.type, period, outcome: r.outcome, count: r.notified } });
  }
  return json({
    ok: true, dry_run: dryRun, outcome: r.outcome, count: r.notified, overdue_days: r.overdue_days,
    people: r.people.map((p) => ({ user_id: p.user_id, user_name: p.user_name, discord_id: p.discord_id, total: p.total })),
  });
}

async function notificationsReset(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ type?: string; period?: string }>(req);
  if (b?.period !== undefined && typeof b.period !== "string") return errorResponse(400, "period must be YYYY-MM");
  const period = b?.period ?? taipeiPeriod();
  if (!b?.type || !NOTIF_TYPES.includes(b.type as any)) return errorResponse(400, "type must be billing_opened or overdue");
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  // The billing_opened row is not a send log — it IS the definition of "this period is open"
  // (core/notify.ts isBillingOpened, core/db.ts listOpenPayablePeriods). Deleting it alone leaves
  // every pending bill standing in a period members can no longer pay: a half retract. The whole
  // operation lives in 收回本期開繳, which also deletes the bills and the upload tokens.
  if (b.type === "billing_opened") {
    return errorResponse(409, "開繳紀錄不能單獨重置（那會讓本期回到未開繳、帳單卻全留著）。請到「繳費審核」使用「收回本期開繳」。");
  }
  const res = await env.DB.prepare("DELETE FROM notification_logs WHERE workspace_id = ? AND type = ? AND period = ?")
    .bind(ws, b.type, period).run();
  const deleted = res.meta.changes ?? 0;
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "notification.reset", entityType: "workspace", entityId: ws, after: { type: b.type, period, deleted } });
  return json({ ok: true, deleted });
}
```

- [ ] **Step 4: 修既有測試**

`packages/worker/test/routes/admin.test.ts:215` 那個 resend 呼叫補 `dry_run: false`：

```ts
    const r = await call("POST", "/admin/notifications/resend", { type: "overdue", period: "2028-03", dry_run: false });
```

同檔 `:230-232` 的驗證案例維持不變（`type: "bogus"` 仍是 400、`period: "bad"` 仍是 400、非字串 period 仍是 400）。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/routes/notifications-danger.test.ts test/routes/admin.test.ts`
Expected: PASS

- [ ] **Step 6: 全套 + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/notifications-danger.test.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(worker): 重發需已開繳（否則 409）、開繳紀錄禁止單獨重置、通知動作支援 dry-run"
```

---

### Task 5: `previewBillingInitiate` —— 發起繳費的影響預覽

**Files:**
- Modify: `packages/worker/src/core/billing.ts`
- Modify: `packages/worker/src/routes/admin.ts:88-103`（`billingInitiate`）
- Modify: `packages/worker/test/routes/admin.test.ts:278, 288-292`
- Test: `packages/worker/test/core/billing-initiate-preview.test.ts`（**新檔，fixture band 9830**）

**Interfaces:**
- Consumes: `ReconcileLine`（已存在於 `billing.ts:221-232`）、`isBillingOpened`。
- Produces：
  ```ts
  export type InitiateNotifyReason = "ok" | "already_sent" | "no_channel" | "no_bot_token" | "no_plans";
  export interface InitiatePlanChange { plan_id: number; plan_name: string; from: number; to: number }
  export interface InitiatePreview {
    period: string;
    opened: boolean;
    will_notify: boolean;
    notify_reason: InitiateNotifyReason;
    plan_changes: InitiatePlanChange[];
    create: ReconcileLine[];
    reprice: ReconcileLine[];
    frozen_count: number;
  }
  export function previewBillingInitiate(
    env: Env, workspaceId: number, period: string, input: InitiateInput
  ): Promise<InitiatePreview>
  ```
  `POST /admin/billing/initiate` body 加 `dry_run?: boolean`（**預設 true**）；dry run 回 `InitiatePreview`，apply 回 `{ ok: true, sent, updated_plans, created_payments, updated_payments }`。Task 11 前端依賴這兩個形狀。

- [ ] **Step 1: 寫失敗的測試**

建立 `packages/worker/test/core/billing-initiate-preview.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { previewBillingInitiate, initiateBillingOpened } from "../../src/core/billing";
import type { Notifier } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9830;
const PLAN_A = 9830, PLAN_B = 98301;
const USER_A = 9830, USER_B = 98301;
const SUB_A = 9830, SUB_B = 98301;
const CHAN = "chan-9830";
const PERIOD = "2096-04";

const notifier: Notifier = { async sendBillingOpened() {}, async sendOverdue() {}, async sendPaymentNudge() {} };

beforeAll(async () => {
  (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
  const settings = JSON.stringify({ discord_billing_channel_id: CHAN });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_A, WS, "A", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER_B, WS, "B", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_A, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN_B, WS, "Claude", "anthropic", 251, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_A, WS, USER_A, PLAN_A, "2096-04-01", 1, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB_B, WS, USER_B, PLAN_B, "2096-04-01", 1, TS, TS),
    // SUB_B 已經有一張 pending 帳單（舊價 251），SUB_A 沒有
    env.DB.prepare(`INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(WS, SUB_B, PERIOD, `${PERIOD}-01`, `${PERIOD}-30`, `${PERIOD}-01`, 251, "pending", "cron", TS, TS),
  ]);
});

describe("previewBillingInitiate", () => {
  const amounts = [{ plan_id: PLAN_A, amount: 400 }, { plan_id: PLAN_B, amount: 300 }];

  it("列出將建立／改價的帳單與定價 before→after，且完全不寫入", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    expect(p.opened).toBe(false);
    expect(p.will_notify).toBe(true);
    expect(p.notify_reason).toBe("ok");
    expect(p.plan_changes).toEqual([
      { plan_id: PLAN_A, plan_name: "ChatGPT", from: 315, to: 400 },
      { plan_id: PLAN_B, plan_name: "Claude", from: 251, to: 300 },
    ]);
    expect(p.create.map((c) => c.user_name)).toEqual(["A"]);   // SUB_A 還沒有帳單
    expect(p.create[0]!.amount).toBe(400);                     // 用新價建立
    expect(p.reprice.map((r) => [r.user_name, r.from, r.to])).toEqual([["B", 251, 300]]);
    expect(p.frozen_count).toBe(0);

    // 預覽是純讀取
    const plan = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(PLAN_A).first<{ monthly_amount: number }>();
    expect(plan!.monthly_amount).toBe(315);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE workspace_id=? AND period=?").bind(WS, PERIOD).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("預覽的筆數與實際套用回報的筆數完全一致", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    const r = await initiateBillingOpened(env, WS, PERIOD, { amounts }, "owner@x", notifier);
    expect(r.createdPayments).toBe(p.create.length);
    expect(r.updatedPayments).toBe(p.reprice.length);
    expect(r.updatedPlans).toBe(p.plan_changes.length);
  });

  it("已開繳的期別預覽為 already_sent（不會再發通知）", async () => {
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts });
    expect(p.opened).toBe(true);
    expect(p.will_notify).toBe(false);
    expect(p.notify_reason).toBe("already_sent");
    expect(p.plan_changes).toEqual([]); // 價格已在上一步寫入，現在沒有差異
  });

  it("已繳的帳單算進 frozen_count，不出現在 reprice", async () => {
    await env.DB.prepare("UPDATE payments SET status='paid' WHERE workspace_id=? AND period=? AND subscription_id=?")
      .bind(WS, PERIOD, SUB_B).run();
    const p = await previewBillingInitiate(env, WS, PERIOD, { amounts: [{ plan_id: PLAN_B, amount: 999 }] });
    expect(p.frozen_count).toBe(1);
    expect(p.reprice.find((r) => r.subscription_id === SUB_B)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/core/billing-initiate-preview.test.ts`
Expected: FAIL —— `previewBillingInitiate is not a function`。

- [ ] **Step 3: 實作**

在 `packages/worker/src/core/billing.ts`，接在 Task 1 新增的 `resendBillingOpenedNotice` 之後：

```ts
// ── "發起繳費" dry run (what an initiate would change, before it changes it) ────

export type InitiateNotifyReason = "ok" | "already_sent" | "no_channel" | "no_bot_token" | "no_plans";

export interface InitiatePlanChange {
  plan_id: number;
  plan_name: string;
  from: number;
  to: number;
}

export interface InitiatePreview {
  period: string;
  /** The period already has a billing_opened record — an initiate would NOT notify again. */
  opened: boolean;
  will_notify: boolean;
  notify_reason: InitiateNotifyReason;
  plan_changes: InitiatePlanChange[];
  /** Bills the initiate would create (active subs with no bill yet), priced at the confirmed amount. */
  create: ReconcileLine[];
  /** Existing PENDING bills whose amount would really change. */
  reprice: ReconcileLine[];
  /** paid/verified bills in this period — never rewritten. */
  frozen_count: number;
}

/**
 * Read-only twin of initiateBillingOpened: same inputs, same rules, zero writes. Every number here
 * must equal what the apply reports (initiate's UPDATE carries `amount != ?` for exactly this
 * reason), because the whole point of the preview is that the admin can trust it.
 */
export async function previewBillingInitiate(
  env: Env,
  workspaceId: number,
  period: string,
  input: InitiateInput
): Promise<InitiatePreview> {
  const plans = (await env.DB
    .prepare("SELECT id, name, monthly_amount, active FROM plans WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ id: number; name: string; monthly_amount: number; active: number }>()).results;
  const planById = new Map(plans.map((p) => [p.id, p]));

  const amountByPlan = new Map<number, number>();
  const plan_changes: InitiatePlanChange[] = [];
  for (const a of input.amounts) {
    const plan = planById.get(a.plan_id);
    if (!plan) continue;
    if (!Number.isInteger(a.amount) || a.amount < 0) continue;
    amountByPlan.set(a.plan_id, a.amount);
    if (a.amount !== plan.monthly_amount) {
      plan_changes.push({ plan_id: plan.id, plan_name: plan.name, from: plan.monthly_amount, to: a.amount });
    }
  }
  const priceOf = (planId: number) => amountByPlan.get(planId) ?? planById.get(planId)?.monthly_amount ?? 0;

  const activeSubs = (await env.DB.prepare(
    `SELECT s.id AS subscription_id, s.plan_id AS plan_id, s.user_id AS user_id,
            u.display_name AS user_name, u.discord_id AS discord_id, pl.name AS plan_name
     FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans pl ON pl.id = s.plan_id
     WHERE s.workspace_id = ? AND s.status = 'active'`
  ).bind(workspaceId).all<{ subscription_id: number; plan_id: number; user_id: number; user_name: string; discord_id: string | null; plan_name: string }>()).results;

  const existing = (await env.DB.prepare(
    `SELECT p.id AS payment_id, p.subscription_id AS subscription_id, p.amount AS amount, p.status AS status
     FROM payments p WHERE p.workspace_id = ? AND p.period = ?`
  ).bind(workspaceId, period).all<{ payment_id: number; subscription_id: number; amount: number; status: string }>()).results;
  const bySub = new Map(existing.map((e) => [e.subscription_id, e]));

  const create: ReconcileLine[] = [];
  const reprice: ReconcileLine[] = [];
  for (const s of activeSubs) {
    const e = bySub.get(s.subscription_id);
    const price = priceOf(s.plan_id);
    if (!e) {
      create.push({ subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: price, discord_id: s.discord_id });
    } else if (e.status === "pending" && amountByPlan.has(s.plan_id) && e.amount !== price) {
      reprice.push({ payment_id: e.payment_id, subscription_id: s.subscription_id, user_id: s.user_id, user_name: s.user_name, plan_name: s.plan_name, amount: price, from: e.amount, to: price, discord_id: s.discord_id });
    }
  }
  const frozen_count = existing.filter((e) => e.status === "paid" || e.status === "verified").length;

  const wsRow = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(workspaceId).first<{ settings: string }>();
  const settings = parseSettings(wsRow!.settings);
  const opened = await isBillingOpened(env.DB, workspaceId, period);
  // Same order of checks initiateBillingOpened applies, so the preview can't promise a notice the
  // apply would skip (A1: no more "✓ 完成" for a send that never happened).
  const noticePlans = activeSubs
    .map((s) => planById.get(s.plan_id))
    .filter((p): p is NonNullable<typeof p> => !!p && p.active === 1);
  const notify_reason: InitiateNotifyReason =
    !settings.discord_billing_channel_id ? "no_channel"
    : !env.DISCORD_BOT_TOKEN ? "no_bot_token"
    : opened ? "already_sent"
    : noticePlans.length === 0 ? "no_plans"
    : "ok";

  return { period, opened, will_notify: notify_reason === "ok", notify_reason, plan_changes, create, reprice, frozen_count };
}
```

改 `src/routes/admin.ts` 的 `billingInitiate`（`:88-103`）：

```ts
async function billingInitiate(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const b = await readJson<{ period?: string; amounts?: { plan_id: number; amount: number }[]; dry_run?: boolean }>(req);
  const period = b?.period ?? taipeiPeriod();
  if (!PERIOD_RE.test(period)) return errorResponse(400, "period must be YYYY-MM");
  if (!Array.isArray(b?.amounts)) return errorResponse(400, "amounts is required");
  for (const a of b!.amounts) {
    if (!a || typeof a !== "object" || !Number.isInteger(a.plan_id) || !Number.isInteger(a.amount) || a.amount < 0) {
      return errorResponse(400, "each amount needs an integer plan_id and non-negative amount");
    }
  }
  // dry_run defaults to true (safe preview) — only an explicit false applies, matching
  // /billing/:period/sync and /billing/:period/retract.
  if (b!.dry_run !== false) {
    return json(await previewBillingInitiate(env, ws, period, { amounts: b!.amounts }));
  }
  const r = await initiateBillingOpened(env, ws, period, { amounts: b!.amounts }, actorOf(ctx), discordNotifier);
  return json({ ok: true, sent: r.sent, updated_plans: r.updatedPlans, created_payments: r.createdPayments, updated_payments: r.updatedPayments });
}
```

在 `admin.ts:9` 的 import 補上 `previewBillingInitiate`：

```ts
import { ensureFirstPayment, initiateBillingOpened, previewBillingInitiate, reconcilePeriodBills, retractPeriodBilling, resendBillingOpenedNotice } from "../core/billing";
```

- [ ] **Step 4: 修既有測試**

`packages/worker/test/routes/admin.test.ts:278` 補 `dry_run: false`：

```ts
    const res = await call("POST", "/admin/billing/initiate", { period: "2027-09", amounts: [{ plan_id: planId, amount: 800 }], dry_run: false });
```

同檔 `:288-292` 的 400 驗證案例不需要改（驗證發生在 dry_run 分支之前），但**再加一個**確認預設是 dry run 的案例，接在 `:293` 之後：

```ts
  it("billing/initiate 預設是 dry run：回傳預覽且不寫入", async () => {
    const pRes = await call("POST", "/admin/plans", { name: "PreviewPlan", provider: "openai", monthly_amount: 100 });
    const planId = ((await pRes!.json()) as any).id as number;
    const res = await call("POST", "/admin/billing/initiate", { period: "2027-10", amounts: [{ plan_id: planId, amount: 700 }] });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.plan_changes).toEqual([{ plan_id: planId, plan_name: "PreviewPlan", from: 100, to: 700 }]);
    const plan = await env.DB.prepare("SELECT monthly_amount FROM plans WHERE id=?").bind(planId).first<{ monthly_amount: number }>();
    expect(plan!.monthly_amount).toBe(100); // 沒有被寫入
  });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/core/billing-initiate-preview.test.ts test/routes/admin.test.ts`
Expected: PASS

- [ ] **Step 6: 全套 + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
git add packages/worker/src/core/billing.ts packages/worker/src/routes/admin.ts packages/worker/test/core/billing-initiate-preview.test.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(worker): 發起繳費支援 dry-run 影響預覽（建立/改價筆數、定價 before→after、是否發通知）"
```

---

### Task 6: A3 —— web token 也要過開繳閘門，upload-link 驗 period 格式

**Files:**
- Modify: `packages/worker/src/routes/upload.ts:69-80`
- Modify: `packages/worker/src/routes/admin.ts`（`createUploadLink`，約 `:792-808`）
- Test: `packages/worker/test/routes/upload-gate.test.ts`（**新檔，fixture band 9840**）

**Interfaces:**
- Consumes: `isBillingOpened`（`src/core/notify.ts`）、`PERIOD_RE`（`admin.ts:35` 已存在）。
- Produces: 無新型別。`POST /upload/:token` 在未開繳期別回 **409** `{ error, code: "payment" }`（沿用既有的 `code: "payment"`，前端已經在處理）。`POST /admin/upload-link` 對格式錯誤的 period 回 **400**。

- [ ] **Step 1: 寫失敗的測試**

建立 `packages/worker/test/routes/upload-gate.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/routes/admin";
import { handleUpload } from "../../src/routes/upload";
import { issueUploadToken } from "../../src/core/tokens";
import { claimNotification } from "../../src/core/notify";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9840;
const PLAN = 9840, USER = 9840, SUB = 9840;
const UNOPENED = "2095-01";
const OPENED = "2095-02";

const router = buildAdminRouter();
const IDENT = { email: "owner@example.com" };
function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  return router.handle(new Request(`https://x${path}`, init), env, { identity: IDENT });
}

async function mintToken(period: string): Promise<string> {
  const { raw } = await issueUploadToken(env.DB, { workspaceId: WS, userId: USER, period, subscriptionId: null, ttlMs: 30 * 60 * 1000 });
  return raw;
}
function uploadReq(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("https://x/upload/t", { method: "POST", body: fd });
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, "{}", TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(USER, WS, "U", TS, TS),
    env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(PLAN, WS, "ChatGPT", "openai", 315, TS, TS),
    env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(SUB, WS, USER, PLAN, "2095-01-01", 1, TS, TS),
  ]);
  for (const p of [UNOPENED, OPENED]) {
    await env.DB.prepare(
      `INSERT INTO payments (workspace_id,subscription_id,period,period_start,period_end,due_date,amount,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(WS, SUB, p, `${p}-01`, `${p}-28`, `${p}-01`, 315, "pending", "cron", TS, TS).run();
  }
  await claimNotification(env.DB, { workspaceId: WS, type: "billing_opened", period: OPENED });
});

describe("POST /upload/:token 的開繳閘門", () => {
  it("未開繳的期別回 409 中文訊息，帳單維持 pending", async () => {
    const raw = await mintToken(UNOPENED);
    const res = await handleUpload(uploadReq({ note: "轉帳了" }), env, { params: { token: raw } } as any);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("payment");
    expect(body.error).toContain("尚未開放");
    const p = await env.DB.prepare("SELECT status FROM payments WHERE subscription_id=? AND period=?").bind(SUB, UNOPENED).first<{ status: string }>();
    expect(p!.status).toBe("pending");
  });

  it("已開繳的期別照常結算", async () => {
    const raw = await mintToken(OPENED);
    const res = await handleUpload(uploadReq({ note: "轉帳了" }), env, { params: { token: raw } } as any);
    expect(res.status).toBe(200);
    const p = await env.DB.prepare("SELECT status FROM payments WHERE subscription_id=? AND period=?").bind(SUB, OPENED).first<{ status: string }>();
    expect(p!.status).toBe("paid");
  });
});

describe("POST /admin/upload-link 的 period 驗證", () => {
  it("格式錯誤的 period 回 400，不會鑄出 token", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_tokens").first<{ n: number }>();
    const res = await call("POST", "/admin/upload-link", { user_id: 1, period: "2026-7" });
    expect(res!.status).toBe(400);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_tokens").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/routes/upload-gate.test.ts`
Expected: FAIL —— 第一個測試拿到 200（帳單被結算成 paid）；第三個拿到 201。

- [ ] **Step 3: 實作**

`packages/worker/src/routes/upload.ts` —— import 補上 `isBillingOpened`：

```ts
import { isBillingOpened } from "../core/notify";
```

在 `handleUpload` 的 `try { const r = await settleUserPeriod(...)` **之前**（即現行 `:69` 上方）插入閘門：

```ts
  // Same gate the Discord path enforces (adapters/discord/handler.ts): a one-time link must not be
  // able to settle a period members cannot otherwise pay — a link minted before a 收回本期開繳
  // would otherwise still go through.
  if (!(await isBillingOpened(env.DB, tok.workspace_id, tok.period))) {
    return errorResponse(409, "本期繳費尚未開放，待管理員發出開繳通知後即可繳費。", { code: "payment" });
  }
```

`packages/worker/src/routes/admin.ts` 的 `createUploadLink`，在 `if (!b?.user_id || !b.period)` 之後補一行（`PERIOD_RE` 已定義於 `:35`）：

```ts
  if (!PERIOD_RE.test(b.period)) return errorResponse(400, "period must be YYYY-MM");
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/routes/upload-gate.test.ts test/routes/upload.test.ts`
Expected: PASS。若 `upload.test.ts` 有既有案例因為新閘門而失敗，**不要放寬閘門** —— 在該測試的 fixture 補 `claimNotification({ type: "billing_opened", period })`，因為那正是它模擬的真實狀態。

- [ ] **Step 5: 全套 + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
git add packages/worker/src/routes/upload.ts packages/worker/src/routes/admin.ts packages/worker/test/routes/upload-gate.test.ts
git commit -m "fix(worker): web 上傳連結也要過開繳閘門；upload-link 驗證 period 格式"
```

---

### Task 7: Discord `/發起繳費` —— 期別選項、預設期別對齊、方案 >5 拒絕、文案

**Files:**
- Modify: `packages/worker/src/adapters/discord/commands.ts:155-161`（`INITIATE_COMMAND`）
- Modify: `packages/worker/src/adapters/discord/handler.ts:232-248`（`handleInitiateCommand`）、`:280-284`（`deferredInitiate` 文案）
- Modify: `packages/worker/test/adapters/discord-initiate.test.ts`
- Test: `packages/worker/test/adapters/discord-initiate-cap.test.ts`（**新檔，fixture band 9850**）

**Interfaces:**
- Consumes: `periodForBillingDay`（`src/core/time.ts`，`handler.ts:4` 已 import）、`PERIOD_RE`（`handler.ts:488`，在 `handleInitiateCommand` 執行時已初始化）、`getOption`（`handler.ts:53`）。
- Produces: `INITIATE_COMMAND` 多一個 optional `期別` string option。`initiateModal` 簽章不變。

- [ ] **Step 1: 寫失敗的測試（>5 方案上限）**

建立 `packages/worker/test/adapters/discord-initiate-cap.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9850;
const GUILD = "guild-9850";
const ADMIN = "admin-9850";
const USER = 9850;
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;
const member = (id: string) => ({ member: { user: { id } } });

beforeAll(async () => {
  const settings = JSON.stringify({ discord_guild_id: GUILD, discord_billing_channel_id: "chan-9850", admin_discord_ids: [ADMIN] });
  const stmts = [
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(WS, "W", "o", "discord", 1, settings, TS, TS),
    env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(USER, WS, ADMIN, "Admin", TS, TS),
  ];
  // 6 個啟用中的方案 → 超過 Discord modal 的 5 欄上限
  for (let i = 0; i < 6; i++) {
    stmts.push(env.DB.prepare(`INSERT INTO plans (id,workspace_id,name,provider,monthly_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(98500 + i, WS, `Plan${i}`, "openai", 100 + i, TS, TS));
    stmts.push(env.DB.prepare(`INSERT INTO subscriptions (id,workspace_id,user_id,plan_id,start_date,billing_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(98500 + i, WS, USER, 98500 + i, "2026-05-01", 1, TS, TS));
  }
  await env.DB.batch(stmts);
});

describe("/發起繳費 的方案數上限", () => {
  it("方案超過 5 個時明確拒絕並指向後台，而不是靜默丟掉第 6 個以後", async () => {
    const i: DiscordInteraction = { type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN), data: { name: "發起繳費" } };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4); // ephemeral message, NOT a modal
    expect(body.data.content).toContain("6");
    expect(body.data.content).toContain("後台");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/adapters/discord-initiate-cap.test.ts`
Expected: FAIL —— `body.type` 是 9（modal），只帶了 5 個方案。

- [ ] **Step 3: 實作**

`packages/worker/src/adapters/discord/commands.ts`，`INITIATE_COMMAND`（`:155-161`）改成：

```ts
/** `/發起繳費` command registration payload (admin-only; real auth = admin_discord_ids). */
export const INITIATE_COMMAND = {
  name: "發起繳費",
  type: 1,
  description: "（管理員）確認指定期別各方案金額並發出開繳通知",
  default_member_permissions: MANAGE_GUILD,
  options: [
    { type: OPT_STRING, name: "期別", description: "YYYY-MM（留空＝目前收款中的期別）", required: false },
  ],
};
```

`packages/worker/src/adapters/discord/handler.ts`，`handleInitiateCommand`（`:232-248`）改成：

```ts
/** Discord modals cap at 5 text inputs; more plans than that cannot be confirmed here. */
const INITIATE_PLAN_CAP = 5;

async function handleInitiateCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  if (!(await isAdmin(env, ws, discordUserId(i)))) return ephemeral("你沒有發起繳費的權限。");

  const plans = await env.DB
    .prepare("SELECT id, name, monthly_amount FROM plans WHERE workspace_id = ? AND active = 1 ORDER BY id")
    .bind(ws)
    .all<{ id: number; name: string; monthly_amount: number }>();
  if (plans.results.length === 0) return ephemeral("沒有啟用中的方案。");
  // Refuse rather than silently confirm only the first five: the notice lists EVERY active plan, so
  // a truncated modal would broadcast the untouched plans at their old prices while the reply
  // claims the amounts were confirmed.
  if (plans.results.length > INITIATE_PLAN_CAP) {
    return ephemeral(
      `目前有 ${plans.results.length} 個啟用中的方案，超過 Discord 表單的 ${INITIATE_PLAN_CAP} 欄上限，` +
      "無法在這裡確認全部金額。請改用後台「設定 → 工具 → 發起繳費」。"
    );
  }

  // Default to the period currently being collected — the same default the dashboard, the payments
  // list and the admin 發起繳費 modal use. To pre-open a later month, pass 期別 explicitly.
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(ws).first<{ billing_day: number }>();
  const typed = getOption(i, "期別")?.value?.trim();
  const period = typed || periodForBillingDay(wsRow?.billing_day ?? 1);
  if (!PERIOD_RE.test(period)) return ephemeral("期別格式需為 `YYYY-MM`，例如 `2026-07`。");
  return json(initiateModal(ws, period, plans.results));
}
```

`deferredInitiate` 的成功文案（`:281-284`）改成帶期別（A5）並回報建立筆數：

```ts
      const r = await initiateBillingOpened(env, ws, period, { amounts }, `discord:${discordUserId(i)}`, discordNotifier);
      content = r.sent
        ? `✅ 已發起 ${period} 繳費並發出通知（新增 ${r.createdPayments} 筆帳單、更新 ${r.updatedPlans} 個方案定價、${r.updatedPayments} 筆待繳金額）。`
        : `✅ 已更新 ${period} 金額（新增 ${r.createdPayments} 筆帳單、更新 ${r.updatedPlans} 個方案、${r.updatedPayments} 筆待繳）。${period} 的開繳通知先前已發送，未重複發送。`;
```

`nextBillingPeriod` 在 `handler.ts` 從此無人使用 —— 把 `handler.ts:4` 的 import 收斂成：

```ts
import { periodForBillingDay } from "../../core/time";
```

（`src/core/time.ts` 的 `nextBillingPeriod` **保留**，它仍是 admin 端「預開下期」的計算來源，且有自己的測試。）

- [ ] **Step 4: 修既有測試**

`packages/worker/test/adapters/discord-initiate.test.ts`：

第 4 行的 import 改成：

```ts
import { periodForBillingDay } from "../../src/core/time";
```

第 14-19 行的註解與常數改成：

```ts
// 發起繳費 modal 現在預設「目前收款中的期別」（與後台一致）：periodForBillingDay(billing_day)。
// 這個 workspace 的 billing_day = 5（下方 seed）。
const PERIOD = periodForBillingDay(5);
```

在 `describe("/發起繳費")` 內、第一個 `it` 之後補一個 A7 的測試：

```ts
  it("可以用 期別 選項指定要開的月份", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN),
      data: { name: "發起繳費", options: [{ name: "期別", value: "2029-11" }] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(9);
    expect(body.data.custom_id).toBe(`chippot:initiate:${WS}:2029-11`);
  });

  it("格式錯誤的 期別 被擋下", async () => {
    const i: DiscordInteraction = {
      type: 2, id: "1", token: "t", guild_id: GUILD, ...member(ADMIN),
      data: { name: "發起繳費", options: [{ name: "期別", value: "2029/11" }] },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("YYYY-MM");
  });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/adapters/`
Expected: PASS

- [ ] **Step 6: 全套 + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
git add packages/worker/src/adapters/discord/ packages/worker/test/adapters/
git commit -m "feat(discord): /發起繳費 可指定期別、預設對齊後台、方案 >5 明確拒絕"
```

---

### Task 8: A6 後端 —— 記錄指令註冊時間

**Files:**
- Modify: `packages/worker/src/env.ts:18-92`
- Modify: `packages/worker/src/routes/admin.ts`（`discordRegisterCommands`，約 `:869-883`）
- Modify: `packages/worker/test/routes/admin.test.ts`（`describe("admin discord slash registration")`）

**Interfaces:**
- Produces: `WorkspaceSettings.discord_commands_registered_at: string`（ISO 時間字串，`""` = 從未註冊）。Task 12 前端讀它。

- [ ] **Step 1: 寫失敗的測試**

在 `packages/worker/test/routes/admin.test.ts` 的 `describe("admin discord slash registration")` 內，於現有 `it(...)` 結尾（`registered` 斷言之後）補上：

```ts
    const wsRes = await call("GET", "/admin/workspace");
    const s = ((await wsRes!.json()) as any).workspace.settings;
    expect(s.discord_commands_registered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/worker && npx vitest run test/routes/admin.test.ts -t "registers the three guild commands"`
Expected: FAIL —— `discord_commands_registered_at` 是 `undefined`。

- [ ] **Step 3: 實作**

`packages/worker/src/env.ts`：

`WorkspaceSettings` 內，`discord_bind_message_id` 那行之後加：

```ts
  /** ISO timestamp of the last successful guild-command registration ("" = never). */
  discord_commands_registered_at: string;
```

`DEFAULT_SETTINGS` 內對應位置加：

```ts
  discord_commands_registered_at: "",
```

`parseSettings` 內對應位置加：

```ts
    discord_commands_registered_at: str(raw.discord_commands_registered_at, ""),
```

`packages/worker/src/routes/admin.ts` 的 `discordRegisterCommands`，在 `if (!res.ok) return errorResponse(502, ...)` 之後、`writeAudit` 之前插入：

```ts
  const registeredAt = nowUtcIso();
  await env.DB.prepare("UPDATE workspaces SET settings = json_set(settings, '$.discord_commands_registered_at', ?), updated_at = ? WHERE id = ?")
    .bind(registeredAt, registeredAt, ws).run();
```

並把最後一行改成把時間帶回前端：

```ts
  return json({ ok: true, registered: commands.length, registered_at: registeredAt });
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/worker && npx vitest run test/routes/admin.test.ts`
Expected: PASS

- [ ] **Step 5: 全套 + commit**

```bash
cd packages/worker && npx vitest run && npx tsc --noEmit
git add packages/worker/src/env.ts packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(worker): 記錄 Discord 指令註冊時間（供後台顯示持久狀態）"
```

---

### Task 9: A4 —— 一種紅、一種確認樣式，`window.confirm` 全部淘汰

**Files:**
- Modify: `packages/admin/src/ui.tsx`（新增 `ConfirmDanger`）
- Modify: `packages/admin/src/views/Manage.tsx:10-24`（刪 `ConfirmDelete`）、`:44-45`、`:95`、`:80-85`、`:121-122`、`:216-217`、`:310-312`
- Modify: `packages/admin/src/views/PaymentDetail.tsx:72-83`
- Modify: `packages/admin/src/views/Settings.tsx:298`
- Modify: `packages/admin/src/styles.css:103-104`（只加註解）

**Interfaces:**
- Produces（Task 10、11 依賴）：
  ```ts
  export function ConfirmDanger(props: {
    title: string;
    message: string;
    confirmLabel?: string;   // 預設 "確認刪除"
    busyLabel?: string;      // 預設 "處理中…"
    onClose: () => void;
    onConfirm: () => Promise<void>;
  }): JSX.Element
  ```

- [ ] **Step 1: 在 `ui.tsx` 新增 `ConfirmDanger`**

在 `packages/admin/src/ui.tsx` 的 `Modal` 之後加：

```tsx
/**
 * The one confirmation shape for a destructive-but-reversible action (deleting a row, clearing a
 * send log, unbinding). Irreversible or outward-facing actions get the two-step preview modal
 * instead (SyncModal / RetractModal / InitiateModal). Both use `btn--danger` — there is exactly one
 * red in this app (`--red`), and `window.confirm` is not used anywhere.
 */
export function ConfirmDanger({ title, message, confirmLabel = "確認刪除", busyLabel = "處理中…", onClose, onConfirm }: {
  title: string; message: string; confirmLabel?: string; busyLabel?: string;
  onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { await onConfirm(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <p style={{ whiteSpace: "pre-wrap", marginBottom: 16, lineHeight: 1.7 }}>{message}</p>
      <div className="btn-row">
        <button className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button className="btn btn--danger" onClick={go} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: `Manage.tsx` 改用它**

- 刪掉 `Manage.tsx:10-24` 整個 `ConfirmDelete` 函式。
- `:3` 的 import 改成：
  ```tsx
  import { useAsync, Card, Modal, Field, Empty, ConfirmDanger } from "../ui";
  ```
- 把四處 `<ConfirmDelete` 改成 `<ConfirmDanger`（`:55`、`:132`、`:226`、`:321` 附近），其餘 props 不動 —— 預設的 `confirmLabel="確認刪除"`、`busyLabel="處理中…"` 正好符合。
- 四張表的「刪除」按鈕改成紅色（`:45`、`:122`、`:217`、`:312`）：
  ```tsx
  <button className="btn btn--danger" onClick={() => setDel(u)}>刪除</button>
  ```
  ```tsx
  <button className="btn btn--danger" onClick={() => setDel(s)}>刪除</button>
  ```
  ```tsx
  <button className="btn btn--danger" disabled={(p.subscription_count ?? 0) > 0} title={(p.subscription_count ?? 0) > 0 ? "使用中，請先刪除訂閱或停用" : ""} onClick={() => setDel(p)}>刪除</button>
  ```
  ```tsx
  <button className="btn btn--danger" disabled={(t.usage_count ?? 0) > 0} title={(t.usage_count ?? 0) > 0 ? "已被繳費紀錄參照，請改用停用" : ""} onClick={() => setDel(t)}>刪除</button>
  ```
- 解除綁定（`:80-85` 的 `unbind` 與 `:95` 的按鈕）改掉 `window.confirm`。在 `UserModal` 內加一個 state 與 modal：

  把 `unbind` 改成：
  ```tsx
  async function unbind() {
    if (!user) return;
    setBusy(true); setErr(null);
    try { await api.updateUser(user.id, { discord_id: "" }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  ```
  在該元件 state 區加：
  ```tsx
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  ```
  按鈕（`:95`）改成：
  ```tsx
  {user?.discord_id && <button className="btn btn--danger" onClick={() => setConfirmUnbind(true)} disabled={busy}>解除綁定</button>}
  ```
  在 `UserModal` 回傳的 `</Modal>` 之前加：
  ```tsx
  {confirmUnbind && (
    <ConfirmDanger
      title="解除 Discord 綁定"
      message={`解除後這位成員的開繳／催繳通知都 @ 不到他，他也不能用 Discord 的「繳費」按鈕登記，直到重新綁定為止。\n他隨時可以自己用綁定按鈕或 /綁定 指令重新綁定。`}
      confirmLabel="確認解除綁定"
      busyLabel="解除中…"
      onClose={() => setConfirmUnbind(false)}
      onConfirm={unbind}
    />
  )}
  ```

- [ ] **Step 3: `PaymentDetail.tsx` 改用它**

- import 補 `ConfirmDanger`。
- 加 state：`const [confirmDel, setConfirmDel] = useState(false);`
- 把 `:72-83` 的刪除按鈕改成：
  ```tsx
      <button className="btn btn--danger" disabled={busy} onClick={() => setConfirmDel(true)}>刪除此筆</button>
      {confirmDel && (
        <ConfirmDanger
          title="刪除此筆繳費紀錄"
          message={payment.status !== "pending"
            ? "這筆已有繳費／審核紀錄，刪除後將從對帳與紀錄中消失且無法復原（稽核紀錄仍會保留）。"
            : "刪除這筆待繳紀錄後，「重新同步本期」會在該訂閱仍為啟用時把它補回來（稽核紀錄仍會保留）。"}
          confirmLabel="確認刪除"
          busyLabel="刪除中…"
          onClose={() => setConfirmDel(false)}
          onConfirm={() => api.deletePayment(payment.id).then(() => { setConfirmDel(false); onDone(); })}
        />
      )}
  ```
  （`onDone` 是 `PaymentDetail` 既有的 prop —— 實作前先確認名稱，若該檔用的是 `run(...)` 包裝，改成呼叫既有的 `run(() => api.deletePayment(payment.id))` 並在成功後 `setConfirmDel(false)`。）

- [ ] **Step 4: `Settings.tsx` 的 CSV 匯入觸發鈕去紅**

`Settings.tsx:298`：

```tsx
      <button className="btn btn--sm" onClick={() => setOpen(true)}>匯入…</button>
```

（`ActionRow` 的 `warn` tag「會新增/暫停訂閱」保留 —— 該有的警告在那裡，而紅色留給真正不可逆的動作。`發起繳費` 的 `btn--sm btn--danger` **不要動**。）

- [ ] **Step 5: 在 `styles.css` 寫下規則**

`packages/admin/src/styles.css:103-104` 上方加註解（**不新增任何 CSS 變數或 class**）：

```css
/* 破壞性動作只有一種紅（--red）與一種按鈕（.btn--danger）：
   不可逆或會對外發送 → .btn--danger + 兩段式預覽 modal（SyncModal / RetractModal / InitiateModal）；
   可逆的破壞性     → .btn--danger + ui.tsx 的 ConfirmDanger。
   `var(--danger, …)` 曾是全站唯一未定義的顏色 token，已於 issue #43 移除，別再引入。 */
.btn--danger { color: var(--red); border-color: #e6c7c2; }
```

- [ ] **Step 6: 驗證沒有殘留**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
grep -rn -e '--danger' -e 'window.confirm' packages/admin/src packages/web/src
```
Expected: **只**出現 `styles.css` 註解裡那一次 `var(--danger, …)` 的說明文字，以及 `.btn--danger` 的 class 名稱。任何 `var(--danger` 的實際用法或 `window.confirm` 呼叫都必須是 0。

- [ ] **Step 7: typecheck + build + commit**

```bash
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
git add packages/admin/src
git commit -m "refactor(admin): 破壞性動作統一 btn--danger + ConfirmDanger，移除未定義的 --danger 與 window.confirm"
```

---

### Task 10: `api.ts` 型別與中文對照

**Files:**
- Modify: `packages/admin/src/api.ts`

**Interfaces:**
- Produces（Task 11、12 依賴）：
  ```ts
  export interface ResendBillingPreview { ok: true; dry_run: boolean; outcome: string; sent: boolean; lines: { plan_id: number; plan_name: string; amount: number; role_id: string | null }[] }
  export interface OverduePreview { ok: true; dry_run: boolean; outcome: string; count: number; overdue_days: number; people: { user_id: number; user_name: string; discord_id: string | null; total: number }[] }
  export interface InitiatePreview { period: string; opened: boolean; will_notify: boolean; notify_reason: string; plan_changes: { plan_id: number; plan_name: string; from: number; to: number }[]; create: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number }
  export interface InitiateApplied { ok: true; sent: boolean; updated_plans: number; created_payments: number; updated_payments: number }
  export const NOTIFY_REASON_TEXT: Record<string, string>
  api.resendNotification(type, period, opts: { dry_run: boolean })
  api.initiateBilling({ period, amounts, dry_run })
  ```

- [ ] **Step 1: 加型別與對照表**

在 `packages/admin/src/api.ts` 的 `RetractApplied`（`:48`）之後加：

```ts
/** POST /admin/notifications/resend, type = billing_opened. */
export interface ResendBillingPreview {
  ok: true; dry_run: boolean;
  outcome: "sent" | "preview" | "not_opened" | "no_channel" | "no_bot_token" | "no_plans";
  sent: boolean;
  lines: { plan_id: number; plan_name: string; amount: number; role_id: string | null }[];
}
/** POST /admin/notifications/resend, type = overdue. */
export interface OverduePreview {
  ok: true; dry_run: boolean;
  outcome: "sent" | "preview" | "no_channel" | "no_bot_token" | "none_due" | "already_sent";
  count: number; overdue_days: number;
  people: { user_id: number; user_name: string; discord_id: string | null; total: number }[];
}
/** POST /admin/billing/initiate with dry_run (the default). */
export interface InitiatePreview {
  period: string; opened: boolean; will_notify: boolean;
  notify_reason: "ok" | "already_sent" | "no_channel" | "no_bot_token" | "no_plans";
  plan_changes: { plan_id: number; plan_name: string; from: number; to: number }[];
  create: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number;
}
export interface InitiateApplied {
  ok: true; sent: boolean; updated_plans: number; created_payments: number; updated_payments: number;
}

/**
 * Why a notice will not / did not go out. Every outward-facing action reports the real outcome
 * instead of a blanket "✓ 完成" (issue #43 / A1) — these are the sentences it reports.
 */
export const NOTIFY_REASON_TEXT: Record<string, string> = {
  no_channel: "尚未設定繳費頻道 ID（設定 → Discord 串接）",
  no_bot_token: "尚未設定 Discord bot token",
  no_plans: "本期沒有任何有啟用訂閱的方案",
  already_sent: "本期開繳通知先前已發送，不會重複發送",
  not_opened: "此期尚未開繳",
  none_due: "本期沒有未繳的成員",
};
```

- [ ] **Step 2: 改三個 client 方法**

```ts
  resendNotification: (type: string, period: string, opts: { dry_run: boolean }) =>
    req<ResendBillingPreview | OverduePreview>("POST", "/notifications/resend", { type, period, ...opts }),
  resetNotification: (type: string, period: string) => req<{ deleted: number }>("POST", "/notifications/reset", { type, period }),
  initiateBilling: (b: { period: string; amounts: { plan_id: number; amount: number }[]; dry_run: boolean }) =>
    req<InitiatePreview | InitiateApplied>("POST", "/billing/initiate", b),
```

- [ ] **Step 3: typecheck 會紅 —— 這是預期的**

Run: `pnpm --filter @chippot/admin typecheck`
Expected: FAIL —— `Dashboard.tsx` 與 `Settings.tsx` 的呼叫端還沒改（Task 11、12 修）。**不要**為了讓 typecheck 過而加 `any`。

- [ ] **Step 4: 先不 commit**

這個 task 的產出與 Task 11 一起 commit（單獨 commit 會留下一個 typecheck 紅的 commit）。直接進 Task 11。

---

### Task 11: P0-1 ＋ A1 ＋ A2 —— 推播狀態改成兩段式

**Files:**
- Create: `packages/admin/src/views/PushStatus.tsx`
- Modify: `packages/admin/src/views/Dashboard.tsx:1-38, 94`

**Interfaces:**
- Consumes: Task 10 的型別與 `NOTIFY_REASON_TEXT`；Task 9 的 `ConfirmDanger`。
- Produces: `export function PushStatus({ period }: { period: string })`。

- [ ] **Step 1: 建立 `PushStatus.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api, NOTIFY_REASON_TEXT, type ResendBillingPreview, type OverduePreview } from "../api";
import { useAsync, Card, Modal, Stat, Empty, ConfirmDanger } from "../ui";
import { DiffList } from "../components/DiffList";

/**
 * 推播狀態 — the dashboard's outward-facing actions. Every one of them posts to a public channel or
 * clears a dedup log, so each goes through the project's two-step shape (preview → named red
 * confirm → report the real numbers), the same as SyncModal / RetractModal.
 *
 * There is deliberately NO "重置" for 開繳通知: that row IS the definition of "this period is open"
 * (worker core/notify.ts isBillingOpened), so deleting it alone leaves every bill standing in a
 * period nobody can pay. The whole operation is 收回本期開繳 on the payments page; the note below
 * the table points there, and the API returns 409 if anything tries anyway.
 */
export function PushStatus({ period }: { period: string }) {
  const { data, reload } = useAsync(() => api.notifications(period), [period]);
  const [open, setOpen] = useState<"resend" | "overdue" | "reset" | null>(null);

  const sentLabel = (at: string | null | undefined) => (at ? `已發送 ${at}` : "未發送");
  const close = () => setOpen(null);
  const done = () => { reload(); };

  return (
    <Card title="推播狀態">
      <div className="tbl">
        <table>
          <thead><tr><th>通知</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td>開繳通知</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.billing_opened?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" onClick={() => setOpen("resend")}>重發開繳通知…</button>
              </td>
            </tr>
            <tr>
              <td>逾期催繳</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.overdue?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" onClick={() => setOpen("overdue")}>催繳未繳成員…</button>{" "}
                <button className="btn btn--danger" onClick={() => setOpen("reset")}>重置催繳發送紀錄…</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ color: "var(--muted-strong)", fontSize: 12.5, lineHeight: 1.7, padding: "10px 20px 16px", margin: 0 }}>
        要把 {period} 改回「未開繳」（成員暫時無法繳費）？請到「繳費審核」使用<b>收回本期開繳</b> ——
        它會一併刪掉未繳／已退回的帳單，不會只留下對不起來的半套狀態。
      </p>

      {open === "resend" && <ResendBillingModal period={period} onClose={close} onDone={done} />}
      {open === "overdue" && <OverdueModal period={period} onClose={close} onDone={done} />}
      {open === "reset" && <ResetOverdueModal period={period} onClose={close} onDone={done} />}
    </Card>
  );
}

/** 重發開繳通知 — re-posts an existing notice. Never creates bills, never changes prices. */
function ResendBillingModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<ResendBillingPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("billing_opened", period, { dry_run: true })
      .then((r) => { if (!off) { setPreview(r as ResendBillingPreview); setBusy(false); } })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.resendNotification("billing_opened", period, { dry_run: false }) as ResendBillingPreview;
      setResult(r.sent
        ? `✓ 已在頻道重發 ${period} 開繳通知（列出 ${r.lines.length} 個方案）。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const ready = preview?.outcome === "preview";
  return (
    <Modal title={`重發開繳通知 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !preview && <Empty>檢查中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {preview && !result && !ready && (
        <p style={{ color: "var(--muted)" }}>無法重發：{NOTIFY_REASON_TEXT[preview.outcome] ?? preview.outcome}。</p>
      )}
      {preview && !result && ready && (
        <>
          <div className="stats"><Stat label="📣 公告方案" value={preview.lines.length} /></div>
          <DiffList title="通知會列出的方案" rows={preview.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`)} />
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            重發只會在繳費頻道再貼一次同樣的開繳通知。<b>不會</b>新增或修改任何帳單、<b>不會</b>改動方案定價，
            期別也全程維持在「已開繳」。成員會再被 @ 一次。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認重發通知</button>
        </>
      )}
    </Modal>
  );
}

/**
 * 催繳未繳成員 — the admin-triggered overdue notice. Named for what it does, because it is NOT the
 * same list as the daily cron: it @s every unpaid member regardless of 逾期天數.
 */
function OverdueModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<OverduePreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("overdue", period, { dry_run: true })
      .then((r) => { if (!off) { setPreview(r as OverduePreview); setBusy(false); } })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.resendNotification("overdue", period, { dry_run: false }) as OverduePreview;
      setResult(r.count > 0
        ? `✓ 已在頻道催繳 ${r.count} 位成員。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const ready = preview?.outcome === "preview";
  return (
    <Modal title={`催繳未繳成員 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !preview && <Empty>計算名單中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {preview && !result && !ready && (
        <p style={{ color: "var(--muted)" }}>無法催繳：{NOTIFY_REASON_TEXT[preview.outcome] ?? preview.outcome}。</p>
      )}
      {preview && !result && ready && (
        <>
          <div className="stats">
            <Stat label="🔔 會 @ 的成員" value={preview.people.length} />
            <Stat label="💰 未繳總額" value={`NT$${preview.people.reduce((s, p) => s + p.total, 0).toLocaleString()}`} />
          </div>
          <DiffList title="會被 @ 的成員" rows={preview.people.map((p) => `${p.user_name} NT$${p.total.toLocaleString()}${p.discord_id ? "" : "（未綁定，@ 不到）"}`)} />
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            這會在繳費頻道公開 @ {period} <b>所有</b>未繳成員（含已退回的），<b>不受</b>「逾期天數（{preview.overdue_days} 天）」限制；
            每日自動催繳只會 @ 已超過逾期天數的人，所以這份名單通常比較長。送出後本期的催繳發送紀錄會更新為現在。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認催繳這 {preview.people.length} 位</button>
        </>
      )}
    </Modal>
  );
}

/** 重置催繳發送紀錄 — clears ONLY the overdue dedup row. No bills, no open/closed state. */
function ResetOverdueModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [result, setResult] = useState<string | null>(null);
  if (result) {
    return (
      <Modal title={`重置催繳發送紀錄 · ${period}`} onClose={onClose}>
        <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>
      </Modal>
    );
  }
  return (
    <ConfirmDanger
      title={`重置催繳發送紀錄 · ${period}`}
      message={`刪除 ${period} 的「逾期催繳」發送紀錄後，每日自動催繳會在下次符合逾期條件時再送一次（同一批人可能被重複 @）。\n\n這只影響催繳的去重紀錄：不會變更任何帳單，也不會影響本期的開繳狀態。`}
      confirmLabel="確認重置"
      busyLabel="重置中…"
      onClose={onClose}
      onConfirm={async () => {
        const r = await api.resetNotification("overdue", period);
        setResult(`✓ 已重置催繳發送紀錄（刪除 ${r.deleted} 筆）。`);
        onDone();
      }}
    />
  );
}
```

- [ ] **Step 2: `Dashboard.tsx` 瘦身**

- 刪掉 `Dashboard.tsx:1-38`（`useState` import 與整個 `PushStatus` 函式），把最前面兩行 import 改成：
  ```tsx
  import { api, periodForBillingDay } from "../api";
  import { useAsync, Card, Stat, Empty, Money } from "../ui";
  import { PushStatus } from "./PushStatus";
  ```
- `:94` 的 `<PushStatus period={effPeriod} />` 保持原樣（現在指向新檔的 export）。

- [ ] **Step 3: typecheck + build**

```bash
pnpm --filter @chippot/admin typecheck
```
Expected: 只剩 `Settings.tsx` 的 `initiateBilling` 呼叫端錯誤（Task 12 修）。若出現 `PushStatus`／`api.ts` 相關錯誤，先修完再繼續。

- [ ] **Step 4: 暫存，不 commit**

`Settings.tsx` 仍會讓 typecheck 紅 —— 接著做 Task 12，兩者一起 commit。

---

### Task 12: P0-2(b) ＋ P0-4 ＋ A5 ＋ A6 —— 發起繳費兩段式、收回文案、持久狀態

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx:233-241, 294-302, 405-445, 447-502`
- Modify: `packages/admin/src/views/Payments.tsx:120, 284-289`

- [ ] **Step 1: `InitiateModal` 改兩段式**

把 `Settings.tsx:405-445` 的 `InitiateBilling` ＋ `InitiateModal` 整段替換：

```tsx
function InitiateBilling({ billingDay, dirty }: { billingDay: number; dirty: boolean }) {
  const plans = useAsync(() => api.plans(), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn--sm btn--danger" onClick={() => setOpen(true)}>發起繳費…</button>
      {open && plans.data && <InitiateModal plans={plans.data.plans.filter((p) => p.active)} billingDay={billingDay} dirty={dirty} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 發起繳費 — the heaviest write in the app (new prices, new bills, a rewrite of this period's
 * pending amounts, and a public broadcast). Two steps like SyncModal / RetractModal: preview what it
 * would change, then a red confirm whose label says whether a notice goes out.
 *
 * The period defaults to the one currently being collected (periodForBillingDay), the same default
 * the dashboard and the payments list use. Pre-opening the NEXT period is an explicit opt-in — with
 * billing_day = 1 the old nextBillingPeriod default silently pointed at next month for 29 days a
 * month, so "fix July's amount" pre-opened August and broadcast it.
 */
function InitiateModal({ plans, billingDay, dirty, onClose }: { plans: { id: number; name: string; monthly_amount: number }[]; billingDay: number; dirty: boolean; onClose: () => void }) {
  const current = periodForBillingDay(billingDay);
  const next = nextBillingPeriod(billingDay) === current ? null : nextBillingPeriod(billingDay);
  const [period, setPeriod] = useState(current);
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(plans.map((p) => [p.id, String(p.monthly_amount)])));
  const [preview, setPreview] = useState<InitiatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const payload = () => ({ period, amounts: plans.map((p) => ({ plan_id: p.id, amount: Number(amounts[p.id]) })) });
  const invalid = plans.some((p) => !/^\d+$/.test((amounts[p.id] ?? "").trim()));

  async function runPreview() {
    setBusy(true); setErr(null);
    try { setPreview(await api.initiateBilling({ ...payload(), dry_run: true }) as InitiatePreview); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.initiateBilling({ ...payload(), dry_run: false }) as InitiateApplied;
      setMsg(
        `✓ 已發起 ${period}：新增 ${r.created_payments} 筆帳單、改價 ${r.updated_payments} 筆、更新 ${r.updated_plans} 個方案定價。` +
        (r.sent ? "已在頻道發出開繳通知。" : `未發送通知：${NOTIFY_REASON_TEXT[preview?.notify_reason ?? ""] ?? "通知未送出"}。`)
      );
    } catch (e) { setErr((e as Error).message); setBusy(false); }
    setBusy(false);
  }

  return (
    <Modal title={`發起繳費 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {msg && (
        <>
          <div style={{ color: "var(--teal)", marginBottom: 10, lineHeight: 1.7 }}>{msg}</div>
          <button className="btn btn--primary" onClick={() => { window.location.hash = "payments"; onClose(); }}>前往繳費審核</button>
        </>
      )}

      {!msg && !preview && (
        <>
          {dirty && <div className="warnnote">你有尚未儲存的設定變更。發起繳費使用<b>已儲存</b>的設定（含結帳日）；如要套用新值，請先回上方「儲存變更」。</div>}
          <p style={{ color: "var(--muted-strong)", fontSize: 13, margin: "0 0 12px", lineHeight: 1.7 }}>
            修改金額即為該方案的<b>新定價</b>（下期沿用）；已繳／已驗證的紀錄不受影響。下一步會先列出這次會改動的帳單與定價，確認後才真的送出。
          </p>
          <Field label="期別"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} /></Field>
          {next && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "-4px 0 14px", fontSize: 13, color: "var(--muted-strong)" }}>
              <input type="checkbox" checked={period === next} onChange={(e) => setPeriod(e.target.checked ? next : current)} disabled={busy} />
              預開下期（{next}）—— 只有在你要提前開下個月時才勾
            </label>
          )}
          {plans.map((p) => (
            <Field key={p.id} label={`${p.name} 金額`}>
              <input type="number" value={amounts[p.id] ?? ""} onChange={(e) => setAmounts((s) => ({ ...s, [p.id]: e.target.value }))} disabled={busy} />
            </Field>
          ))}
          <button className="btn btn--primary" onClick={runPreview} disabled={busy || invalid}>{busy ? "計算影響中…" : "預覽影響…"}</button>
        </>
      )}

      {!msg && preview && (
        <>
          <div className="stats">
            <Stat label="➕ 新增帳單" value={preview.create.length} />
            <Stat label="🔄 改價" value={preview.reprice.length} />
            <Stat label="🏷️ 方案改價" value={preview.plan_changes.length} />
            <Stat label="🔒 保留(已繳)" value={preview.frozen_count} />
          </div>
          {preview.plan_changes.length > 0 && (
            <DiffList title="方案定價（永久生效）" rows={preview.plan_changes.map((c) => `${c.plan_name} NT$${c.from.toLocaleString()} → NT$${c.to.toLocaleString()}`)} />
          )}
          {preview.create.length > 0 && <DiffList title="將建立的帳單" rows={preview.create.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {preview.reprice.length > 0 && <DiffList title="將改價的待繳帳單" rows={preview.reprice.map((a) => `${a.user_name}·${a.plan_name} ${a.from}→${a.to}`)} />}
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            {preview.will_notify
              ? `送出後會在繳費頻道公開發出 ${preview.period} 的開繳通知並 @ 各方案身分組。`
              : `送出後${preview.notify_reason === "already_sent" ? "不會再發通知" : "不會發出通知"}：${NOTIFY_REASON_TEXT[preview.notify_reason] ?? preview.notify_reason}。`}
            {preview.frozen_count > 0 && `　已繳／已驗證的 ${preview.frozen_count} 筆一律原樣保留。`}
          </p>
          <div className="btn-row">
            <button className="btn" onClick={() => setPreview(null)} disabled={busy}>回上一步</button>
            <button className="btn btn--danger" onClick={apply} disabled={busy}>
              {preview.will_notify ? "確認發起並通知" : "確認發起（不會發通知）"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
```

`Settings.tsx:2-4` 的 import 改成：

```tsx
import { api, currentPeriod, periodForBillingDay, nextBillingPeriod, NOTIFY_REASON_TEXT, type ImportDiff, type ImportSubLine, type InitiatePreview, type InitiateApplied } from "../api";
import { useAsync, Card, Field, Empty, Modal, Stat, IconCheck, IconWarning } from "../ui";
import { DiffList } from "../components/DiffList";
```

- [ ] **Step 2: A5 —— 工具列文案去掉「本期」**

`Settings.tsx:238`：

```tsx
          <ActionRow title="發起繳費" tag="會改價＋發通知" warn desc="確認指定期別的各方案金額，建立該期帳單並向所有成員發出開繳通知。送出前會先看影響預覽。"><InitiateBilling billingDay={savedBillingDay} dirty={dirty} /></ActionRow>
```

- [ ] **Step 3: A6 —— 三個「立即執行」顯示持久狀態**

`ActionRow`（`:255-265`）加一個 `state` prop：

```tsx
function ActionRow({ title, tag, desc, warn, state, children }: { title: string; tag: string; desc: string; warn?: boolean; state?: ReactNode; children: ReactNode }) {
  return (
    <div className={`actionrow${warn ? " actionrow--warn" : ""}`}>
      <div className="actionrow__main">
        <div className="actionrow__title">{title} <span className={`tag${warn ? " tag--warn" : ""}`}>{tag}</span></div>
        <div className="actionrow__desc">{desc}</div>
        {state != null && <div className="actionrow__desc" style={{ marginTop: 4 }}>{state}</div>}
      </div>
      <div className="actionrow__act">{children}</div>
    </div>
  );
}
```

在 `Settings()` 內、`const r2 = ...`（`:154`）附近算出三個狀態（`data.workspace.settings` 已經有這三個欄位）：

```tsx
  const s0 = (data as any)?.workspace?.settings ?? {};
  const posted = (id: string) => (id ? <>目前：<b>已張貼</b>（訊息 id <span className="mono">{id}</span>）</> : <>目前：<b>尚未張貼</b></>);
  const payMsgState = posted(s0.discord_payment_message_id ?? "");
  const bindMsgState = posted(s0.discord_bind_message_id ?? "");
  const cmdState = s0.discord_commands_registered_at
    ? <>目前：<b>已註冊</b>（{String(s0.discord_commands_registered_at).slice(0, 10)}）</>
    : <>目前：<b>尚未註冊</b></>;
```

`發起繳費` 與 `匯入名單 CSV` 兩列**不加** `state` —— 期別開沒開屬於「繳費審核」頁的資訊（IA-04／批次 E），在這裡重複宣稱只會多一個會過期的真相來源。

三個 `ActionRow` 各加 `state`（`:235-237`）：

```tsx
          <ActionRow title="重建常駐繳費訊息" tag="立即執行" desc="在繳費頻道重新貼一則含「繳費」按鈕的常駐訊息。" state={payMsgState}><RebuildMessage /></ActionRow>
          <ActionRow title="張貼／更新綁定按鈕訊息" tag="立即執行" desc="在帳單頻道貼一則含「綁定 Discord」按鈕的公開訊息，讓成員主動綁定（開繳／催繳才能 @ 到他）。" state={bindMsgState}><RebuildBindMessage /></ActionRow>
          <ActionRow title="註冊 Discord 指令" tag="立即執行" desc="更新 /繳費、/發起繳費、/綁定 指令到你的伺服器。" state={cmdState}><RegisterCommands /></ActionRow>
```

（`initiateState` 是 `null`，等於 `發起繳費` 那列不顯示額外狀態列 —— 保留變數是為了讓上面那行 `ActionRow` 的 props 明確；若 lint 抱怨未使用，直接把 `state={initiateState}` 與該變數一起刪掉。）

- [ ] **Step 4: P0-4 —— 收回的 tooltip 與彈窗內文**

`packages/admin/src/views/Payments.tsx:120`：

```tsx
        <button className="btn btn--danger" disabled={!effPeriod} title={effPeriod ? "刪除本期未繳／已退回帳單，期別回到未開繳" : "請先選擇單一期別"} onClick={() => setRetract(true)}>收回本期開繳</button>
```

`Payments.tsx:284-288` 那段說明加一句上傳連結失效：

```tsx
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            收回後本期回到「未開繳」：刪掉的帳單不會被「重新同步本期」補回來，日後可以再次發起繳費（屆時會重新發送開繳通知）。
            此期先前用「產生上傳連結」發出去的一次性連結會<b>立即失效</b>，對方點開只會看到連結無效。
            {preview.frozen_count > 0 && `已繳／已驗證的 ${preview.frozen_count} 筆一律原樣保留，重開本期也不會重複開帳單。`}
            已經發出的 Discord 開繳通知不會撤回，必要時請自行到頻道說明。
          </p>
```

同一個 modal 的「將刪除的帳單」標題已寫「（未繳／已退回）」，維持不動。

- [ ] **Step 5: typecheck + build**

```bash
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```
Expected: 兩者都通過、零錯誤。

- [ ] **Step 6: Commit（含 Task 10、11 的檔案）**

```bash
git add packages/admin/src
git commit -m "feat(admin): 推播狀態與發起繳費改兩段式預覽、誠實回報筆數；收回文案補齊；工具列顯示持久狀態"
```

---

### Task 13: 文件

**Files:**
- Modify: `README.md:12, 218-226`
- Modify: `README.zh-TW.md:206-213`

- [ ] **Step 1: 更新 `README.md`**

`:221-222` 的 `發起繳費` 那段改成：

```markdown
- **發起繳費** — confirm the selected period's per-plan amounts (any change becomes the plan's new
  price), preview exactly which bills would be created/repriced and whether a notice goes out, then
  apply. Defaults to the period being collected; pre-opening next month is an explicit opt-in.
  Triggerable from the admin Settings or Discord's `/發起繳費` (which takes an optional 期別 and
  refuses when a workspace has more than 5 active plans — use the admin UI there).
```

`:225-226` 的 `Push status` 那段改成：

```markdown
- **Push status** — the dashboard shows whether the billing-opened / overdue notices went out, with
  **重發開繳通知** (re-posts the notice only — never creates bills, never clears the open marker),
  **催繳未繳成員** (@s every unpaid member regardless of 逾期天數, unlike the cron) and
  **重置催繳發送紀錄**. All three preview first and report the real counts. Reopening/closing a
  period lives in 收回本期開繳 on the payments page, not here.
```

- [ ] **Step 2: 更新 `README.zh-TW.md`**

`:209-210` 改成：

```markdown
- **發起繳費** — 確認所選期別各方案金額（任何更動就是該方案的新定價），先看「會建立／改價哪些帳單、
  定價 before→after、是否會發通知」的預覽，確認後才送出。預設期別是**目前收款中的那一期**，
  「預開下期」是要自己勾的次要選項。可從後台「設定」或 Discord 的 `/發起繳費` 觸發
  （後者可帶 `期別`，方案超過 5 個時會直接請你改用後台）。
```

`:213` 改成：

```markdown
- **推播狀態** — 看板顯示開繳／逾期通知是否已發，並提供 **重發開繳通知**（只重貼公告，不建帳單、
  不會讓期別短暫變回未開繳）、**催繳未繳成員**（@ 全部未繳者，與只 @ 逾期者的每日 cron 不同）
  與 **重置催繳發送紀錄**。三者都先預覽再確認，並回報真實筆數。要把期別改回未開繳請用
  「繳費審核 → 收回本期開繳」。
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-TW.md
git commit -m "docs(readme): 更新推播狀態與發起繳費的行為說明（issue #43）"
```

---

### Task 14: 驗收 —— 全套測試、typecheck、build、CDP 人工證據

**Files:** 無（只跑驗證）

- [ ] **Step 1: 後端全套**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot/packages/worker && npx vitest run
```
Expected: 全綠，且 **tests 總數 > 300**（基準線）。把實際數字記下來 —— 下一步要寫進 badge。

- [ ] **Step 2: 更新測試數 badge**

把 `README.md:12` 的 `tests-300%20passing` 改成 Step 1 實測的數字。**不要猜**，用 vitest 印出的那個數。

```bash
git add README.md && git commit -m "docs(readme): 更新測試數 badge"
```

- [ ] **Step 3: 全 repo typecheck 與 build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm -r typecheck && pnpm -r build
```
Expected: 兩者皆零錯誤。

- [ ] **Step 4: 確認沒有殘留的舊模式**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
grep -rn 'window.confirm' packages/admin/src packages/web/src            # 必須 0 筆
grep -rn 'var(--danger' packages/admin/src --include='*.tsx'             # 必須 0 筆
grep -rn 'force: true' packages/worker/src/core/billing.ts               # 必須 0 筆
grep -rn 'nextBillingPeriod' packages/worker/src/adapters                # 必須 0 筆
```

- [ ] **Step 5: CDP 人工驗收（admin 沒有測試框架，這是它的證據）**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot/packages/admin && pnpm dev
```

用 Chrome DevTools MCP 對 dev server 逐項確認並**留下截圖**：

1. **看板 → 推播狀態**：`開繳通知` 那列**只有一顆**「重發開繳通知…」，沒有任何「重置」；`逾期催繳` 那列有「催繳未繳成員…」與「重置催繳發送紀錄…」。表格下方有指向「收回本期開繳」的說明。
2. 點「重發開繳通知…」在一個**未開繳**的期別 → modal 顯示「無法重發：此期尚未開繳」，且**沒有**確認按鈕。
3. 點「催繳未繳成員…」→ 先看到名單與「不受逾期天數限制」的說明，確認鈕是紅的且字樣含人數。
4. **設定 → 工具 → 發起繳費…** → 期別預設值等於看板的期別（不是下個月）；勾「預開下期」才會跳到下個月；按「預覽影響…」後看到四張統計卡與 DiffList，確認鈕文字依 `will_notify` 變化。
5. **繳費審核**：hover「收回本期開繳」看到新 tooltip（含「已退回」與「回到未開繳」）；開啟 modal 看到「一次性連結會立即失效」那句。
6. **成員／訂閱／方案／支付渠道**四張表的「刪除」是紅字；點下去出現 modal（不是瀏覽器原生 confirm），確認鈕是 `btn--danger` 的紅字（**不是** `#c0392b` 那個橘紅）。
7. **設定 → 工具**：三列都有「目前：已張貼／尚未張貼／已註冊…」的狀態行；「匯入…」按鈕**不再是紅色**。
8. **零橫向溢出回歸**：在 375px 與 768px 下，對每個新／改動過的 modal 執行
   ```js
   document.documentElement.scrollWidth === document.documentElement.clientWidth
   ```
   Expected: 全部 `true`。

- [ ] **Step 6: 建 PR**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git push -u origin ux/43-danger-actions
```

PR body（zh-TW）必須包含：
- `Closes #43`
- 一段 **Breaking changes** 明列三件事：`initiateBillingOpened` 移除 `opts.force`；`sendOverdueForPeriod` 改回傳 `OverdueResult`；`POST /admin/billing/initiate` 與 `POST /admin/notifications/resend` 的 `dry_run` **預設為 true**（既有腳本若直接打這兩支 API，必須改帶 `dry_run: false` 才會實際執行）。
- 一段說明 `POST /admin/notifications/reset` 對 `billing_opened` 改回 409 是刻意的行為移除。
- Step 5 的截圖。

---

## UI 終態契約（批次 B／C／D 依此建構）

> 這一節是本批次收工後 UI 的**權威描述**。之後的批次若要改動這裡列出的字串或流程，必須明確說明是在取代哪一條。

### 1. 按鈕標籤（精確字面）

| 位置 | 標籤 | class | 確認方式 |
|---|---|---|---|
| 看板 → 推播狀態 → 開繳通知 | `重發開繳通知…` | `btn btn--danger` | 兩段式 modal `重發開繳通知 · {period}` |
| 看板 → 推播狀態 → 逾期催繳 | `催繳未繳成員…` | `btn btn--danger` | 兩段式 modal `催繳未繳成員 · {period}` |
| 看板 → 推播狀態 → 逾期催繳 | `重置催繳發送紀錄…` | `btn btn--danger` | `ConfirmDanger`，確認鈕 `確認重置` |
| 繳費審核 工具列 | `重新同步本期` | `btn` | 既有 `SyncModal`（不動） |
| 繳費審核 工具列 | `收回本期開繳` | `btn btn--danger` | 既有 `RetractModal`（文案已補） |
| 設定 → 工具 | `發起繳費…` | `btn btn--sm btn--danger` | 兩段式 `InitiateModal` |
| 設定 → 工具 | `匯入…` | `btn btn--sm`（**去紅**） | 既有 `ImportModal`（不動） |
| 設定 → 工具 | `重建` / `張貼／更新` / `註冊` | `btn btn--sm` | 無（各列上方有「目前：…」狀態行） |
| 成員／訂閱／方案／渠道 列內 | `刪除` | `btn btn--danger` | `ConfirmDanger`，確認鈕 `確認刪除` |
| 編輯成員 modal | `解除綁定` | `btn btn--danger` | `ConfirmDanger`，確認鈕 `確認解除綁定` |
| 繳費詳情 modal | `刪除此筆` | `btn btn--danger` | `ConfirmDanger`，確認鈕 `確認刪除` |

### 2. 移除／搬移的項目

| 原本 | 現在 |
|---|---|
| 看板 → 推播狀態 → 開繳通知列的 `重置` 按鈕 | **刪除**。後端 `POST /admin/notifications/reset` 收到 `billing_opened` 回 **409**。 |
| 看板 → 推播狀態 → 開繳通知列的 `立即重發` | 改名 `重發開繳通知…`，並改走只重貼公告的路徑（不再建帳單、不再 delete-then-claim marker）。 |
| 看板 → 推播狀態 → 逾期催繳列的 `立即重發` | 改名 `催繳未繳成員…`（名實相符：@ 全部未繳者）。 |
| 看板 → 推播狀態的 `✓ 完成` | **刪除**。改為各 modal 內回報真實筆數（`✓ 已在頻道催繳 N 位成員。` 等）。 |
| `Dashboard.tsx` 內的 `PushStatus` | 搬到 `packages/admin/src/views/PushStatus.tsx`。 |
| `Manage.tsx` 內的 `ConfirmDelete` | 搬到 `packages/admin/src/ui.tsx`，更名 `ConfirmDanger`，可自訂確認字樣。 |
| `var(--danger, #c0392b)` | **刪除**，全站唯一的紅是 `--red`。 |
| `window.confirm`（2 處） | **刪除**，改 `ConfirmDanger`。 |

### 3. Modal 流程

**`重發開繳通知 · {period}`**（兩段式）
1. 開啟即 `dry_run: true`。未開繳 → 只顯示「無法重發：此期尚未開繳。」，**無確認鈕**。
2. 可重發 → 統計卡 `📣 公告方案`＋DiffList「通知會列出的方案」＋一段「重發只會再貼一次公告，不會新增或修改帳單、不會改定價、期別全程維持已開繳」＋紅鈕 `確認重發通知`。
3. 結果：`✓ 已在頻道重發 {period} 開繳通知（列出 N 個方案）。` 或 `未發送：{中文原因}`。

**`催繳未繳成員 · {period}`**（兩段式）
1. `dry_run: true` 取名單。
2. 統計卡 `🔔 會 @ 的成員` / `💰 未繳總額`＋DiffList（未綁定者標「（未綁定，@ 不到）」）＋一段講清楚「不受逾期天數（N 天）限制，與每日自動催繳名單不同」＋紅鈕 `確認催繳這 N 位`。
3. 結果：`✓ 已在頻道催繳 N 位成員。` 或 `未發送：{中文原因}`。

**`重置催繳發送紀錄 · {period}`**（ConfirmDanger）
- 內文明講：只影響催繳去重紀錄、不動帳單、不影響開繳狀態、下次符合逾期條件會再送一次。
- 結果：`✓ 已重置催繳發送紀錄（刪除 N 筆）。`

**`發起繳費 · {period}`**（兩段式，三個畫面）
1. 表單：期別（預設 `periodForBillingDay`）＋「預開下期（{next}）」checkbox（僅當 next ≠ current 才出現）＋各方案金額＋主要鈕 `預覽影響…`。
2. 預覽：四張統計卡（`➕ 新增帳單` / `🔄 改價` / `🏷️ 方案改價` / `🔒 保留(已繳)`）＋三個 DiffList（方案定價 before→after、將建立的帳單、將改價的待繳帳單）＋一段「是否會發通知」＋`回上一步`（`btn`）與紅鈕 `確認發起並通知` ／ `確認發起（不會發通知）`。
3. 結果：`✓ 已發起 {period}：新增 N 筆帳單、改價 N 筆、更新 N 個方案定價。…` ＋ `前往繳費審核` 按鈕（`btn btn--primary`，設 `location.hash = "payments"`）。

**`收回本期開繳 · {period}`**（既有，只改文案）
- tooltip：`刪除本期未繳／已退回帳單，期別回到未開繳`
- 內文新增一句：此期先前發出的一次性上傳連結會**立即失效**。

### 4. Discord 側

- `/發起繳費` 指令描述：`（管理員）確認指定期別各方案金額並發出開繳通知`
- 新增 optional option `期別`，description `YYYY-MM（留空＝目前收款中的期別）`
- 預設期別：`periodForBillingDay(billing_day)`（與後台一致）
- 啟用方案 > 5 → ephemeral 拒絕：`目前有 N 個啟用中的方案，超過 Discord 表單的 5 欄上限，無法在這裡確認全部金額。請改用後台「設定 → 工具 → 發起繳費」。`
- 期別格式錯誤 → ephemeral：`` 期別格式需為 `YYYY-MM`，例如 `2026-07`。 ``
- 送出成功文案帶期別與建立筆數（不再說「本期」）。

### 5. API 契約

| Endpoint | 變更 |
|---|---|
| `POST /admin/notifications/resend` | 新增 `dry_run`（**預設 true**）。`billing_opened` 未開繳 → **409**。回傳 `{ ok, dry_run, outcome, sent, lines }`（billing_opened）或 `{ ok, dry_run, outcome, count, overdue_days, people }`（overdue）。 |
| `POST /admin/notifications/reset` | `type: "billing_opened"` → **409**。`overdue` 行為不變。 |
| `POST /admin/billing/initiate` | 新增 `dry_run`（**預設 true**）。dry run 回 `InitiatePreview`；apply 回 `{ ok, sent, updated_plans, created_payments, updated_payments }`。 |
| `POST /admin/upload-link` | period 格式錯誤 → **400**。 |
| `POST /upload/:token` | 期別未開繳 → **409** `{ error: "本期繳費尚未開放…", code: "payment" }`。 |
| `POST /admin/discord/register-commands` | 回傳新增 `registered_at`；寫入 `settings.discord_commands_registered_at`。 |

### 6. 這批次**沒有**改的東西（B／C／D 可以放心接手）

- `重新同步本期` 的按鈕字面、`SyncModal` 的流程與文案（含 `移除（已退訂）` 這個 P0-7 的錯字 —— 屬批次 D）。
- 全站「本期 vs 此期」的用詞不一致（D3）、`核准／驗證` 四種說法（D1）、`已繳 vs 已繳待驗`（D2）—— 全屬批次 D。
- `routes/admin.ts` 既有的英文錯誤訊息（D14）—— 本批次只把**新增**的訊息寫成中文。
- 行動版斷點、`.tbl-cards` 範圍、focus 樣式、對比度 —— 全屬批次 B。
- 成員回饋迴路（receipt 通知、成員 web 頁的英文錯誤）—— 全屬批次 C。

---

## Self-Review

**1. Spec coverage** —— issue #43 逐項對照：

| 項目 | Task |
|---|---|
| P0-1 重置行為分離 | Task 4（後端 409）＋ Task 11（UI 移除 billing_opened 的重置、overdue 改名加 confirm、指向收回） |
| P0-2(a) resend 409 | Task 1（只重貼的新函式）＋ Task 4（409 閘門） |
| P0-2(b) 發起繳費兩段式預覽＋預設期別＋預開下期 | Task 5（後端 dry-run）＋ Task 12（前端） |
| P0-3 Discord >5 方案 | Task 7 |
| P0-4 收回 tooltip ＋ modal 文案 | Task 12 Step 4 |
| A1 誠實回報 | Task 1／3（後端 outcome）＋ Task 10（中文對照）＋ Task 11／12（UI 用真數字） |
| A2 立即重發語意 | Task 3（dry-run ＋ overdue_days 帶回）＋ Task 11（改名＋預覽講清與 cron 的差異） |
| A3 web token 閘門＋period 驗證 | Task 6 |
| A4 一種紅、一種確認 | Task 9 |
| A5 「本期」名不符實 | Task 7（Discord）＋ Task 12 Step 2（後台） |
| A6 立即執行的持久狀態 | Task 8（後端時間戳）＋ Task 12 Step 3（三列狀態行） |
| A7 Discord 期別選項 | Task 7（**未 descope**） |

全部有歸屬，無缺口。

**2. Placeholder scan** —— 全文無 TBD／TODO／「類似 Task N」／「加上適當的錯誤處理」。每個 code step 都有可直接貼上的完整程式碼；每個測試 step 都有完整測試檔或完整的 diff 片段。

**3. Type consistency** —— 交叉核對過：
- `ResendBillingResult { outcome, sent, lines }`：Task 1 定義 → Task 4 route 展開 → Task 10 `ResendBillingPreview` → Task 11 消費。名稱一致。
- `OverdueResult { notified, outcome, overdue_days, people }`：Task 3 定義 → Task 3 cron 用 `.notified` → Task 4 route 映射成 `count` → Task 10 `OverduePreview.count` → Task 11 用 `r.count` 與 `preview.people`。route 那層的 `notified → count` 改名是刻意的（維持既有 API 欄位名），已在 Task 4 的 Interfaces 明講。
- `InitiateResult { sent, updatedPlans, createdPayments, updatedPayments }`：Task 2 定義 → Task 5 route 轉 snake_case → Task 10 `InitiateApplied` → Task 12 消費。
- `InitiatePreview`：Task 5（worker）與 Task 10（admin）**同名不同檔**，欄位逐一相同（`period, opened, will_notify, notify_reason, plan_changes, create, reprice, frozen_count`）。
- `ConfirmDanger` 的 props（`title/message/confirmLabel/busyLabel/onClose/onConfirm`）在 Task 9 定義，Task 9 與 Task 11 的所有呼叫端都只用這六個。
- `previewBillingInitiate` / `resendBillingOpenedNotice` / `sendOverdueForPeriod` 三個函式名在計畫全文拼寫一致。
