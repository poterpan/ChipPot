# 期別帳單對帳 ＋ 繳費紀錄 CRUD 補完 — 設計

> 日期：2026-06-23　狀態：設計定稿，待寫實作計畫
> 主題：修正帳本上的錯誤。四件相關功能合一份 spec。

## 1. 背景與目標

「發起繳費」(`initiateBillingOpened`) 在按下的當下，對**當時每個 `active` 訂閱**各建一筆 pending 帳單。
所謂「鎖定當下使用者」其實只是「那一刻把帳單建出來了」——之後名單漂移就回不去。實測缺口（成員對話 2026-06-23）：

| 漂移情境 | 現況行為 | 結果 |
|---|---|---|
| 有人新增方案／新成員 | initiate/cron 只對 active 訂閱 `ensurePeriodPayment` | 預開月份**沒有他的帳單** |
| 軟性退訂（狀態改 cancelled/paused，保留成員） | initiate/cron 從不刪帳單 | **殘留一筆待繳爛單** |
| 方案改價 | 只有 initiate 改 pending 金額 | 預開月份金額是舊的 |
| 整筆刪訂閱 | cascade 連帶刪 payments | 已乾淨（非缺口） |

連帶在 CRUD review 中發現**兩個成對的洞**：
- **繳費紀錄無法單筆刪除**：payments 只能靠 cascade（刪成員/訂閱）消失，無 `DELETE` 端點。
- **`verified` 是狀態機死路**（`PAYMENT_TRANSITIONS.verified = []`）：一旦驗證就不能退回/改/刪。
  唯一逃生口是 `manualPayment` 的 `ON CONFLICT DO UPDATE` 暗門（非直覺、繞過狀態機）。

兩者合起來 → **驗錯一筆就完全救不回來**。

> **與 2026-06-07 CRUD-delete spec 的決議反轉**：當時刻意把 payments 排除在硬刪之外（視為交易/稽核紀錄、只走狀態轉換）。
> 實務上「誤建的待繳單」「驗錯的單」沒有任何回復路徑，所以本 spec 反轉該決議，補上**單筆硬刪 + 撤回驗證**。
> 用 **audit 保留 before-image** 與 **強制二次確認** 來緩解「失去歷史」的疑慮。

**四件功能**：
1. 重新同步本期帳單（reconcile）
2. 同步新增成員 → 推繳費按鈕提醒（targeted nudge）
3. 刪除單筆繳費紀錄
4. 撤回驗證（解 verified 死路）

外加兩個小坑：`updateUser` 的 `email/note` 改 COALESCE（順手硬化）；`manualPayment` ON CONFLICT 保留不動。

## 2. 關鍵前提（schema / 既有機制）

- 外鍵**無 `ON DELETE CASCADE`**；payments 參照 subscriptions、channel_tags（`verified_channel_tag_id` / `declared_channel_tag_id`）。
- `payments.status ∈ ('pending','paid','verified','rejected')`；`subscriptions.status ∈ ('active','paused','cancelled')`。
- `payments.screenshot_key` 可能指向 R2 物件（R2 選填，`if (key && env.BUCKET)` guard）。
- `upload_tokens` 以 `payment` 無直接外鍵，但有 `subscription_id`/`user_id`；單筆刪 payment 時清同 (sub, period) 的 token（見 §5）。
- 「已開期別」＝ `notification_logs` 有一列 `type='billing_opened' AND period=?`（手動 initiate 與 cron 月初都會寫；`listOpenPayablePeriods` 同義）。
- 繳費按鈕：`payButtonRow(workspaceId, version)`，custom_id = `chippot:pay:{ws}:{version}`；點擊 → `handlePayButton` → `listOpenPayablePeriods` 列出已開又欠繳的月份 → 可繳。
- `notification_logs`、`audit_logs` 以**值**記 id → 刪 payment 不動它們（audit 保留刪除紀錄）。

---

## 3. 功能 1：重新同步本期帳單（reconcile）

### 3.1 核心函式（新增 `packages/worker/src/core/billing.ts` → `reconcilePeriodBills`）

對某 `workspace × period`，相對目前 `status='active'` 訂閱計算並（非 dryRun 時）套用：

| 動作 | 規則 |
|---|---|
| ➕ **新增** | active 訂閱在本期沒帳單 → 以方案現價建 pending（沿用 `ensurePeriodPayment`） |
| ➖ **移除** | 本期 `status IN ('pending','rejected')` 且其訂閱**非 active** → 刪該列；連帶清 R2 截圖 + 同 (sub,period) 的 upload_token |
| 🔄 **改價** | active 訂閱的 **pending** 帳單 → `amount = 方案現價`（會覆蓋手動 pending 覆寫；逐筆列在預覽，含 from→to） |
| 🔒 **凍結** | `paid` / `verified` 一律不碰 |

簽章：

```ts
interface ReconcileLine { payment_id?: number; subscription_id: number; user_name: string;
                          plan_name: string; amount: number; from?: number; to?: number; discord_id: string | null; }
interface ReconcileDiff { opened: boolean;
  add: ReconcileLine[]; remove: ReconcileLine[]; reprice: ReconcileLine[]; frozen_count: number; }

async function reconcilePeriodBills(
  env: Env, workspaceId: number, period: string,
  opts: { dryRun: boolean }
): Promise<ReconcileDiff>
```

- 先查 `opened`；若未開 → 回 `{ opened:false, add:[],remove:[],reprice:[],frozen_count:0 }`，**不做任何寫入**（dryRun 與 apply 皆然）。
- diff 計算純讀；非 dryRun 時用 `env.DB.batch` 一次套用 add/remove/reprice。
- R2 截圖刪除：對 remove 清單中有 `screenshot_key` 者，`if (key && env.BUCKET) BUCKET.delete(key)`（去重）。
- **TOCTOU**：apply 一律伺服器端重算 diff 再套用（不信任前端傳回的 preview）；回傳實際套用後的 counts。
- audit：`billing.reconcile`，`after = { period, added, removed, repriced, frozen }`。
- **不發任何 Discord 通知**（新增成員的通知由功能 2 的選項另外處理，見 §4）。

### 3.2 API（`routes/admin.ts`）

`POST /admin/billing/:period/reconcile`，body `{ dry_run: boolean, notify_added?: boolean }`：
- `dry_run:true` → 只回 `ReconcileDiff`，不寫入、不通知。
- `dry_run:false` → 重算並套用，回 `{ ok:true, applied:{added,removed,repriced,frozen}, notified?: number }`；
  若 `notify_added:true` 則在套用後對「已綁定的新增成員」發功能 2 的提醒（見 §4），`notified` = 實際 ping 人數。
- `period` 以 `PERIOD_RE` 驗格式；非已開期別時 apply 直接回 `{ ok:true, applied:{0,0,0,0} }`（無事可做）。

### 3.3 前端（`packages/admin/src/views/Dashboard.tsx` — 對帳看板）

- 工具列加按鈕 **「重新同步本期帳單」**（針對目前選的 `effPeriod`）。
- 點擊 → 開 Modal → 先打 `dry_run:true` 預覽：
  - `opened:false` → 顯示「此期尚未發起繳費，無需同步」，不給套用鈕。
  - 否則顯示差異卡：➕N / ➖M / 🔄K（可展開逐筆 from→to）/ 🔒J 保留。
  - 若 `add` 中有 ≥1 位**已綁定**成員 → 顯示勾選框「在頻道 @ 通知這 X 位新成員並附繳費按鈕」（**預設勾**）；未綁定者不計入、附註說明。
- 「確認套用」→ 打 `dry_run:false`（帶 `notify_added` = 勾選狀態）→ toast（含套用/通知計數）→ `reload()`。
- 套用中按鈕禁用（in-flight）。

---

## 4. 功能 2：同步新增成員 → 推繳費按鈕提醒（targeted nudge）

借用催繳的「精準 @ 個人」機制 + 開繳通知的繳費按鈕，做一則**針對性提醒**（非 DM，是帳單頻道公開訊息但只 ping 指定人）。

### 4.1 Notifier 介面（`core/notify.ts` + `adapters/discord/notify.ts`）

新增方法（沿用 `OverduePerson` 的精準 mention 模式 + `payButtonRow`）：

```ts
// core/notify.ts Notifier 介面
sendPaymentNudge(env: Env, channelId: string, workspaceId: number, period: string,
                 people: OverduePerson[]): Promise<void>;
```

Discord 實作：
- content（中性文案，非催繳語氣），例：`📋 已將你加入 {period} 繳費名單：\n{list}\n請點下方按鈕繳費。`
  `list` 逐人列 `<@discord_id> 方案 NT$金額（合計 …）`。
- `components: [payButtonRow(workspaceId)]`
- `allowed_mentions: { parse: [], users: [去重的 discord_id] }`（只 ping 這些人，文案/名稱不會誤觸 ping）。

### 4.2 觸發

- 只在功能 1 的 apply（`dry_run:false` 且 `notify_added:true`）後觸發。
- 對象 = 本次 `add` 清單中 `discord_id != null` 的成員；**未綁定者排除**（無法 @、ping 無意義）。
  路由層把 `add` 的行**依 user 聚合**成 `OverduePerson`（一人多方案合併 lines + total）再傳入 `sendPaymentNudge`。
- 前提：`settings.discord_billing_channel_id` 與 `env.DISCORD_BOT_TOKEN` 皆存在；否則略過、不報錯（前端勾選框在無頻道時不顯示）。
- 無 dedup（一次性針對性訊息；頻率由管理員透過勾選框控制）。
- 按下按鈕後流程：`handlePayButton → listOpenPayablePeriods` 會列出此已開又欠繳月份 → 新成員可直接繳。

---

## 5. 功能 3：刪除單筆繳費紀錄

### 5.1 API

`DELETE /admin/payments/:id`：
- 限 workspace（`p.workspace_id === wsId(ctx)`，否則 404）。
- **任何狀態皆可刪**（強確認在前端）。硬刪 + 連帶：
  1. `if (p.screenshot_key && env.BUCKET) BUCKET.delete(p.screenshot_key)`
  2. 刪同 (subscription_id, period) 的 `upload_tokens`
  3. 刪該 payment 列
- audit：`payment.delete`，`before` = 完整 payment 列，`after = { deleted: true }`。
- 回 `{ ok: true }`。

### 5.2 前端（`Payments.tsx` → `PaymentDetail` modal）

- 新增危險色按鈕「刪除此筆」。
- `pending`/`rejected` → 單次確認即可。
- `paid`/`verified` → **二次確認**，警告文案：「這是已收款紀錄，刪除後會從對帳消失且無法復原（仍保留稽核紀錄）。」
- 成功 → 關 modal + `reload()`。
- `api.ts` 加 `deletePayment(id) => req("DELETE", \`/payments/${id}\`)`。

---

## 6. 功能 4：撤回驗證（解 verified 死路）

### 6.1 狀態機（`core/payments.ts`）

`PAYMENT_TRANSITIONS.verified` 由 `[]` 改為 `["pending"]`：

```ts
verified: ["pending"],
```

新增 `unverifyPayment(db, id)`：走 `applyTransition(db, id, "pending", ...)`，清掉
`verified_by=NULL, verified_at=NULL, verified_channel_tag_id=NULL`。
（`allowedSources("pending")` 將自動包含 `verified`；其餘轉換不受影響。）

### 6.2 API + 前端

- `POST /admin/payments/:id/unverify` → `unverifyPayment` → audit `payment.unverify`（before/after）→ 回 `{ ok:true, payment }`。
  非 verified 時 `applyTransition` 拋 `InvalidPaymentTransition` → 409。
- `PaymentDetail` modal：`status==='verified'` 時顯示「撤回驗證」按鈕（次要樣式）→ 確認 → 撤回後該筆回 pending，可再走驗證/退回/刪除。
- `api.ts` 加 `unverify(id) => req("POST", \`/payments/${id}/unverify\`)`。

---

## 7. 小坑修正

- **`updateUser`**：`email = ?`、`note = ?` 改為 `email = COALESCE(?, email)`、`note = COALESCE(?, note)`，避免 partial PATCH 清空既有值。
  `discord_id` 維持可設 null（解綁語意刻意保留）。
- **`manualPayment` ON CONFLICT**：保留不動（管理員萬能覆寫，補了正規刪除/撤回後更不重要、無害）。

## 8. 測試（vitest-pool-workers，真 D1/R2）

- **`reconcilePeriodBills`**：add（缺漏補上、用現價）/ remove（非 active 的 pending+rejected 刪除、active 的不刪、paid/verified 凍結）/ reprice（pending→現價、覆寫手動覆寫）/ frozen_count / `opened:false` 不寫入 / dryRun 不寫入 / R2 截圖被清。
- **reconcile 路由**：dryRun vs apply、未開期別、`notify_added` 走 nudge 且只 ping 已綁定者。
- **`sendPaymentNudge`**：content 含按鈕、`allowed_mentions.users` 只含已綁定 id、無頻道時略過。
- **payment delete**：各狀態皆可刪、R2 截圖清理、upload_token 清理、audit before、404 跨 workspace。
- **unverify**：`verified → pending` 清欄位、非 verified 回 409、撤回後可再驗證。
- **`updateUser` COALESCE**：partial PATCH 不清空 email/note。

## 9. 範圍外（YAGNI / 後續）

- 結帳日自動 reconcile（cron）：**不做**（owner 選手動，可預測）。
- 常駐公開綁定按鈕：**另一份 spec**，排在本批之後（見 memory `chippo-bind-button-queued`）。
- reconcile 的 nudge 機制（`sendPaymentNudge`）未來可被「中途新增單一訂閱」重用，但本批只接 reconcile。
