# 常駐公開綁定按鈕 — 設計

> 日期：2026-06-23　狀態：設計定稿（方向已與 owner 確認），待寫實作計畫
> 前置：見 memory `chippo-bind-button-queued`，排在「期別對帳＋繳費 CRUD」(PR #19) 之後。

## 1. 背景與目標

目前綁定是**被動**的：成員第一次按「繳費」或用 `/綁定` 且未綁定時才跳出選名字。代價是沒繳費前都沒綁，導致開繳通知無法個別 @、催繳對未綁定者 ping 不到、PR #19 的「新增成員推按鈕」也只能 ping 已綁定的人。

**目標**：在 Discord 頻道**常駐一則公開訊息**，附「綁定」按鈕，讓成員主動點擊綁定（onboarding 前置補滿）。**保留**付款時綁定作為 fallback（兩者並存，非二選一）。

## 2. 關鍵前提（既有機制，全部沿用）

- **常駐訊息模式**（`discordPaymentMessage`，admin.ts）：讀 `settings.discord_billing_channel_id` + 一個 `*_message_id`；有 id → `editChannelMessage`，否則 `createChannelMessage` → 用 `json_set` 存回 settings。
- **綁定流程**（handler.ts）：`handleBindCommand` = 已綁定→ephemeral 提示；否則 `listUnboundUsers` → 0 則提示無人可綁；否則 ephemeral 附 `bindSelectRow(ws, "cmd", unbound)`。`handleBindSelect` 走 `bindDiscordId`（atomic guarded UPDATE）。
- **按鈕回應**：component 互動可回 ephemeral（type 4 `RT_MESSAGE` + `FLAG_EPHEMERAL`），與 slash 指令回應相同 → `handleBindCommand` 可直接服務按鈕。
- **prefix 重疊**：`BIND_SELECT_PREFIX = "chippot:bind"`。新按鈕 prefix 必須在 dispatch 中**先於** select 檢查（比照 `PAY_PERIOD_PREFIX` 先於 `PAY_BUTTON_PREFIX`）。
- `bindSelectRow` 已 `slice(0, 25)`（Discord select 上限）。

## 3. 元件設計

### A. 綁定按鈕 row（`adapters/discord/commands.ts`）
- 新 `export const BIND_BUTTON_PREFIX = "chippot:bindbtn"`（**不可**用 `chippot:bind`，會與 `BIND_SELECT_PREFIX` 撞）。
- 新 `bindButtonRow(workspaceId = 1)` → 一顆 `綁定 Discord` 按鈕，custom_id `${BIND_BUTTON_PREFIX}:${workspaceId}`，style 2（次要色，與繳費的 primary 區隔）。

### B. 按鈕路由（`adapters/discord/handler.ts`）
- `handleComponent` 在 `BIND_SELECT_PREFIX` 檢查**之前**加：
  `if (cid.startsWith(BIND_BUTTON_PREFIX)) return handleBindCommand(i, env);`
  （`"chippot:bindbtn:1".startsWith("chippot:bind")` 為 true，故順序必須在前。）
- 直接複用 `handleBindCommand`（其回應 = 已綁定提示／未綁定的 ephemeral 選單，對按鈕與指令皆有效；`resolveWs` 從 guild_id 解析 ws，不依賴 custom_id）。

### C. 設定欄位（`env.ts`）
- `WorkspaceSettings` 加 `discord_bind_message_id: string`；`DEFAULT_SETTINGS` 與 `parseSettings` 同步（沿用 `str(raw.x, "")`）。無 migration（settings 是 JSON，parseSettings 補預設）。

### D. 張貼/更新訊息端點（`routes/admin.ts`）
- `discordBindMessage`（鏡像 `discordPaymentMessage`）：需 `discord_billing_channel_id` + bot token；body = 固定中性文案（例：「👋 還沒綁定的成員，點下方按鈕綁定你的 Discord，之後開繳/催繳才能 @ 到你。」）+ `[bindButtonRow(ws)]`；有 `discord_bind_message_id` → edit，否則 create → `json_set` 存回；audit `discord.bind_message`。
- 路由 `POST /admin/discord/bind-message`。

### E. 後台 UI（`admin/src/views/Settings.tsx`）
- 在現有「重建繳費訊息」（`api.rebuildPaymentMessage`）旁，加一顆「張貼/更新綁定按鈕訊息」→ `api.rebuildBindMessage()`。
- `api.ts` 加 `rebuildBindMessage: () => req<{ message_id: string }>("POST", "/discord/bind-message")`。

## 4. 已知限制（YAGNI）
- Discord string-select 上限 25。`bindSelectRow` 已 slice(0,25)。本 workspace 為 9 人社團，遠低於上限；**>25 人的分頁/搜尋不在本次範圍**（沿用 memory 註記，未來再處理）。本次若 unbound > 25，僅前 25 人可由按鈕自綁，其餘走 `/綁定` 或管理員手動。

## 5. 測試
- handler：bind 按鈕（type 3, custom_id `chippot:bindbtn:<ws>`）→ 未綁定者得到附 `bindSelectRow` 的 ephemeral；已綁定者得到「你已綁定為 X」；確認 dispatch 不被 `BIND_SELECT_PREFIX` 誤攔（順序正確）。
- 路由：`POST /admin/discord/bind-message` 在設好 channel + token（stub fetch）時 create→存 `discord_bind_message_id`、二次呼叫 edit；未設 channel → 400。

## 6. 範圍外
- 真正的 >25 分頁/搜尋綁定。
- 把綁定按鈕併入繳費常駐訊息（本次採**獨立訊息**，職責清晰）。
