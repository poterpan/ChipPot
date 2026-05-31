# ChipPot — 後台增強設計 spec

> 2026-05-31。三個獨立的後台小功能：① 自訂提醒文字、② 列表快速驗證、③ 推播狀態 + 重發/重置。
> 順帶把逾期催繳從「每筆一則」改為「每人彙整一則」（owner 決定）。

## 範圍

- **F1 自訂提醒文字**：逾期、開繳、常駐繳費訊息三種文字皆可在後台自訂（單一模板 + 變數佔位符）。
- **F2 列表快速驗證**：審核列表每列一鍵驗證，不必點進詳情 modal。
- **F3 推播狀態 + 重發/重置**：看本期推播狀態；開繳與逾期皆可「立即重發」或「重置狀態」。
- **逾期形式變更（基礎）**：催繳改為**公開頻道、每人彙整一則**（一次 tag、列出該人各逾期方案）。

> 不做：個人 DM 催繳（需對方開放 DM、失敗難察覺）。模板不做「每方案各一套」（單一模板足夠）。

---

## 基礎變更：逾期催繳改為「每人彙整一則」

目前 `scheduled.ts` 對每筆逾期 payment 各發一則、去重 key 為（ws, period, **subscription**）。改為：

- **依使用者彙整**：cron 觸發條件＝該使用者在該 period 有**≥1 筆 pending 且已逾期**
  （`daysBetween(due_date, today) >= overdue_days`）；觸發後訊息**列出該人該期所有 pending payment**
  （各方案 + 金額 + 總額），發**一則**、tag 一次。
- **去重 key 改為（ws, type='overdue', period, user_id）**：`NotificationKey` 的 overdue 改用 `userId`（不再用 `subscriptionId`）。
- `core/notify.ts` 的 `OverdueTarget` 改為彙整型別：
  ```ts
  export interface OverdueTarget {
    user_id: number;
    period: string;
    discord_id: string | null;
    user_name: string;
    lines: { plan_name: string; amount: number }[];
    total: number;
  }
  ```
- `Notifier.sendOverdue(env, channelId, target, template)`（新增 template 參數，見 F1）。

---

## F1 — 自訂提醒文字

### 設定欄位（workspace settings）
新增三個字串（`WorkspaceSettings` + `DEFAULT_SETTINGS` + `parseSettings` 用 `str(...)`，**預設＝現有文字**）：
- `overdue_template`
- `billing_opened_template`
- `payment_message_template`

### 佔位符（`core/templates.ts` 的 `renderTemplate(tpl, vars)` 把 `{key}` 換值；未知 `{x}` 原樣保留）
- **逾期** `overdue_template`：`{mention}`（有綁＝`<@id>`，沒綁＝`{name}`）、`{name}`、`{lines}`（每方案一行
  `・<方案>：NT$<金額>`）、`{total}`、`{period}`。
  - 預設：`⏰ {mention} 你本期（{period}）尚有未繳：\n{lines}\n合計 NT${total}，請儘速處理 🙏`
- **開繳** `billing_opened_template`：`{period}`、`{plans}`（每方案一行：身分組 tag／粗體方案名＋金額）、`{total}`。
  - 預設：`📢 **{period} 開始繳費**\n{plans}\n\n請點下方「繳費」按鈕，或使用 \`/繳費\` 指令（可附截圖）。`
- **常駐訊息** `payment_message_template`：`{period}`（其餘自由文字）。
  - 預設：`💳 **AI 訂閱繳費**\n點下方「繳費」按鈕選擇繳費渠道送出（一次涵蓋你所有訂閱），或使用 \`/繳費\` 指令（可附截圖／備註）。`

### 渲染位置（保持核心/adapter 分離）
Discord-specific 語法（`<@id>`、`<@&role_id>`）留在 Discord adapter；`renderTemplate` 是純字串核心。
- `adapters/discord/notify.ts`：
  - `sendBillingOpened`：用 lines 組 `{plans}`（`l.role_id ? <@&role> : **name**` + 名稱 + 金額）與 `{total}` → `renderTemplate(template, {period, plans, total})` → content + `payButtonRow()`。
  - `sendOverdue`：用 target 組 `{mention}`、`{lines}`、`{total}` → `renderTemplate(template, {...})` → content + `allowed_mentions: {parse:['users']}`。
- 模板由呼叫端（`scheduled.ts`／重發路徑／重建訊息路由）從 settings 傳入。
- `routes/admin.ts` 的 `discordPaymentMessage`（重建常駐訊息）改用 `renderTemplate(settings.payment_message_template, {period: taipeiPeriod()})`。

### 後台 UI（設定頁）
三個 `<textarea>` + 各自的佔位符小抄 + 「還原預設」按鈕（把該欄設回預設常數）。存檔走既有 `PATCH /admin/workspace`。

---

## F2 — 列表快速驗證

- `packages/admin/views/Payments.tsx`：列表每列加一個「✅ 驗證」鈕，**只在 `status ∈ {pending, paid, rejected}`** 顯示。
- onClick：`e.stopPropagation()`（不開詳情 modal）→ `api.verify(p.id, null)`（後端 verify 已會在未指定時自動帶入**申報渠道** `declared_channel_tag_id`）→ 成功後 reload；進行中 disable。
- **不需新後端**（沿用 `POST /admin/payments/:id/verify`）。

---

## F3 — 推播狀態 + 重發/重置

### 狀態查詢
`GET /admin/notifications?period=YYYY-MM` → 讀 `notification_logs`：
```json
{
  "billing_opened": { "sent_at": "…" } | null,
  "overdue": [ { "user_id": 3, "user_name": "…", "sent_at": "…" } ]
}
```
（overdue join users 取名字；以新 user_id key 為準。）

### 立即重發 `POST /admin/notifications/resend { type, period }`
- `type='billing_opened'`：重用 `initiateBillingOpened(env, ws, period, { amounts: [] }, actor, notifier, { force: true })`
  ——`amounts:[]`＝不改價；新增 `opts.force`：**先刪掉該期 billing_opened 的 notification_logs 列**再 claim，所以即使先前發過也會重發。回 `{ sent }`。
- `type='overdue'`：呼叫新核心 `resendOverdue(env, ws, period, notifier)`：對該期**每個仍有 pending payment 的使用者**
  （管理員手動重發＝略過 `overdue_days` 閘門，直接催所有未繳者），**先刪該人 overdue log**→ 彙整發一則 →
  重新 claim（寫回 log）。回 `{ count }`。
- 寫 audit `notification.resend`。

### 重置狀態 `POST /admin/notifications/reset { type, period }`
- `DELETE FROM notification_logs WHERE workspace_id=? AND type=? AND period=?`（overdue 會刪掉該期所有 overdue 列）。回 `{ deleted }`。
- 下次每日 cron 依規則重發（**開繳的重置只在結帳日當天 cron 重發**；要當下重發請用「立即重發」或發起繳費。逾期則下次 cron 即重發）。
- 寫 audit `notification.reset`。

### 共用重構
- `core/billing.ts`：`initiateBillingOpened` 加 `opts?: { force?: boolean }`；force 時於 claim 前先刪該期 billing_opened log。
- `core/scheduled.ts`：把「彙整某 period 逐人發送逾期」抽成可重用 `sendOverdueForPeriod(env, ws, period, notifier, { force })`，
  cron 與 `resendOverdue` 共用。對象：**非 force**＝有 ≥1 筆 pending 且已逾期（`overdue_days`）的使用者；
  **force**＝所有仍有 pending 的使用者。送出：force 先刪該人 log→發→claim；非 force 走 claim-then-send（已發過則跳過）。
  兩者訊息都列出該人該期所有 pending payment。

### 後台 UI（對帳看板）
本期新增「推播狀態」卡：顯示開繳（已發時間/未發）、逾期（已通知人數/名單）；開繳與逾期各兩個鈕「立即重發」「重置」。
呼叫新 api：`notifications(period)`、`resendNotification(type, period)`、`resetNotification(type, period)`。

---

## 影響的檔案（概要）
- `src/env.ts`：3 個模板設定 + 預設 + parse。
- `src/core/templates.ts`（新）：`renderTemplate`。
- `src/core/notify.ts`：`OverdueTarget` 改彙整型別；`Notifier` 兩方法加 `template` 參數；overdue `NotificationKey` 用 `userId`。
- `src/adapters/discord/notify.ts`：渲染兩模板。
- `src/core/scheduled.ts`：逾期改逐人彙整 + 抽 `sendOverdueForPeriod`。
- `src/core/billing.ts`：`initiateBillingOpened` 加 `force`。
- `src/core/notices.ts`（新，或併入 scheduled）：`resendOverdue`。
- `src/routes/admin.ts`：`GET /admin/notifications`、`POST /admin/notifications/resend`、`POST /admin/notifications/reset`；`discordPaymentMessage` 用模板。
- `packages/admin`：設定頁 3 模板、Payments 快速驗證、Dashboard 推播狀態卡、api methods。

## 測試重點
- 模板：`renderTemplate` 換值/未知保留；逾期彙整一人多方案 → 一則含各方案 + 總額 + 一次 tag；改了模板 → 套用；沒改 → 維持預設輸出。
- 逾期去重改 user_id：同人多方案只發一則、只 claim 一次；cron 第二次不重發。
- 快速驗證：列表一鍵 verify → 帶入申報渠道、狀態變 verified；非可驗證狀態不顯示鈕。
- 推播狀態：GET 回正確狀態；resend billing_opened（force 先刪 log）→ 重發；resend overdue → 逐人重發；reset → 刪 log、下次 cron 行為正確。

## 待確認 / 已決定
- (決定) 三種通知都可自訂、單一模板 + 佔位符。
- (決定) 逾期＝公開頻道、每人彙整一則；去重改 user_id。
- (決定) 快速驗證一鍵直驗、自動帶申報渠道。
- (決定) 開繳與逾期都「立即重發 + 重置」；開繳重置後也可用發起繳費（設定頁/Discord）當下重發。
