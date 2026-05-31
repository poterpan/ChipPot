# ChipPot — 成員上線（名單匯入 + Discord 自助綁定）設計 spec

> 2026-05-31。把社團既有訂閱名單（原 Google 表單）搬進 ChipPot，並讓成員把自己的 Discord
> 帳號接上系統。**一次性 9 人名單已於 2026-05-31 透過 SQL 直接載入正式 D1**（清空舊測試資料、
> 保留 plans/channel_tags/workspace 設定），本 spec 涵蓋**剩下的可重複功能**：後台 CSV 匯入器
> 與 Discord 自助綁定。

## 背景 / 現況

- 正式 D1 現有 9 位成員（`discord_id` 全為 NULL）、12 筆 active 訂閱、12 筆 2026-05 pending payment。
- plans：1=ChatGPT(315)、2=Claude Standard(251)、3=Claude Premium(1258)；workspace billing_day=5。
- 系統以 `users.discord_id` 認人（按鈕/`/繳費` 走 `getUserByDiscordId`）。**Discord API 拿不到 Email**，
  所以 Email↔DiscordID 無法自動對應 → 需自助綁定。

## 目標 / 不做的事

- **Discord 自助綁定（核心、必做）**：未綁定成員在 Discord 把自己的 `discord_id` 接到名單上的那筆 user。
- **後台 CSV 匯入器（可重複，未來批次用）**：上傳 Google 表單匯出的 CSV → upsert users + subscriptions。
- 採「**A 自助綁定 + B 後台可手動補填**」；自助指認用「**選名字下拉**」（owner 決定）。
- **不做**：以 Email 透過 Discord 自動配對（API 不給 Email）；guild 名單 fuzzy 比對（不可靠）。
- **不在本 spec**：自訂提醒文字、列表快速驗證、推播狀態/重發（另開 admin-enhancements spec）。

---

## A. Discord 自助綁定

### 進入點（綁定下拉的 custom_id 會記住進入點 `origin` ∈ {pay, cmd}）
1. **未綁定者按「繳費」**（主要，`origin=pay`）：`handlePayButton` 解析 ws+discord_id 後查
   `getUserByDiscordId`；找不到時，若該 workspace 還有**未綁定**成員 → 回 **`origin=pay` 的綁定下拉**
   （ephemeral）；若沒有未綁定成員 → 維持原訊息（「請聯絡管理員」）。
2. **`/綁定` 指令**（`origin=cmd`）：叫出 **`origin=cmd` 的綁定下拉**。
3. **`/繳費`（slash，未綁定）**：因為是 deferred **文字** 回覆、無法塞下拉，回提示
   「你還沒綁定 Discord 帳號，請點「繳費」按鈕或用 `/綁定` 完成綁定後再試。」（不在文字流裡綁定。）

### 綁定下拉
- string select，`custom_id = chippot:bind:<ws>:<origin>`（origin = `pay` | `cmd`），`min_values=1, max_values=1`。
- 選項 = 該 workspace **`discord_id IS NULL`** 的 users（`label=display_name, value=user_id`），
  依 id 排序，**上限 25**（社團 9 人足夠；>25 的退路見下）。
- 提示文字：「請選擇你的名字以綁定 Discord 帳號（只會列出尚未綁定的成員）。」

### 選擇送出 → 綁定（`handleBindSelect`）
- 解析 `custom_id` 取 `ws`（嚴格驗證，與 `chippot:paysel` 同模式：欄位數/型別不符 → 失效訊息）。
- `targetUserId = Number(values[0])`，必須屬於該 ws 且 **目前 `discord_id IS NULL`**。
- 原子綁定（單一 guarded UPDATE，避免兩人同時綁同一筆 / 同一帳號綁兩筆）：
  ```sql
  UPDATE users SET discord_id = ?, updated_at = ?
   WHERE id = ? AND workspace_id = ? AND discord_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ? AND discord_id = ?)
  ```
  binds：discordId, now, targetUserId, ws, ws, discordId。
- `changes === 1` → 成功；否則查明原因回對應訊息：
  - 此 Discord 帳號已綁到別人（`SELECT … WHERE workspace_id=? AND discord_id=?`）→
    「你的 Discord 帳號已綁定為 <name>。」
  - 該名字已被別人搶綁（target 的 discord_id 已非 NULL）→「這個名字剛被綁定了，請重新操作。」
- 成功回應依 `origin` 分流（皆用 `RT_UPDATE_MESSAGE` 取代原綁定訊息）：
  - **`origin=pay`（從繳費按鈕進來）→ 綁定後自動接續繳費**：直接回繳費流程的下一步畫面（同
    `handlePayButton` 解析成功後的內容——把該段抽成共用 `buildPayPrompt(env, ws, userId)`，回
    `{ content, components }`：列出本期應繳各方案+總額+渠道下拉；若 0 筆可繳→「已登記繳費」；
    0 渠道→改用 `/繳費` 提示）。訊息前綴可加「✅ 已綁定為 <name>。」
  - **`origin=cmd`（從 `/綁定` 進來）→ 只綁定**：「✅ 已綁定為 <display_name>。之後點「繳費」按鈕或用
    `/繳費` 即可登記繳費。」（清掉元件，不接續繳費。）
- audit：`writeAudit(action='member.bind', entityType='user', entityId=targetUserId, after={discord_id})`。

### 防呆 / 邊界
- 冒名風險：小社團可接受（owner 決定選名字）。名單外的人看得到名字清單但只能誤選他人 → 由管理員事後修正。
- 已綁定者按「繳費」：走原本流程，不受影響。
- >25 未綁定成員：`/綁定` 下拉只顯示前 25，訊息提示「名單過長，請聯絡管理員手動綁定」；後台手動填補（B）。

### B. 後台手動補填（已存在，確認可用）
- 後台「成員」編輯表單已有 Discord ID 欄位（`PATCH /admin/users/:id`）。確認：填 discord_id 時若與
  同 workspace 既有成員衝突，回 400（目前 schema `UNIQUE(workspace_id, discord_id)` 會擋；補一個明確錯誤訊息）。

---

## B. 後台 CSV 匯入器（可重複）

### 核心 `core/import.ts`
- `parseRosterCsv(text): { name: string; email: string; plans: string[] }[]`
  - 第一列為標頭：`姓名,帳號,<planA>,<planB>,…`。前兩欄固定（姓名、帳號=email），其餘欄為方案名稱。
  - 每列：值為 `TRUE`（不分大小寫）才算訂閱該方案；蒐集該列為 TRUE 的方案名稱。
  - 略過空白列；`帳號` 空白的列計入 `skipped`。
- `importRoster(env, workspaceId, rows, opts): ImportSummary`
  - `opts.startDate`（預設 = 當月 Taipei 第一天，如 `2026-06-01`）。
  - 先載入該 ws 的 active plans（name→id map）。
  - 每列：
    1. **upsert user（match by email）**：
       - 既有（同 ws 同 email）→ 更新 `display_name`，**保留 discord_id**；用其既有 id。
       - 不存在 → INSERT（`discord_id` NULL）。
    2. 該列每個 TRUE 方案：
       - 名稱對不到 active plan → 記入 `unmatchedPlans`（不中斷）。
       - 已有該 (user, plan) **active** 訂閱 → `skippedSubs++`。
       - 否則 INSERT subscription（start_date=opts.startDate, billing_day=ws.billing_day, status=active）
         並呼叫 **`ensureFirstPayment`**（沿用既有邏輯產生起算月 pending payment；與一次性載入一致）。
  - 回傳 `ImportSummary { usersCreated, usersUpdated, subsCreated, subsSkipped, rowsSkipped, unmatchedPlans: string[] }`。
- **冪等**：重跑同 CSV → 全部命中既有，不重覆建立。

### 路由 `POST /admin/members/import`
- Access-gated（沿用 admin router）。接 multipart（欄位 `file`）或 JSON `{ csv: string, start_date?: string }`。
- 讀 CSV 文字 → `parseRosterCsv` → `importRoster(... startDate ...)` → 回 `ImportSummary`。
- 寫 audit `roster.import`（after=summary）。

### 後台 UI（Settings 或 Manage 新增「匯入名單」）
- 檔案選擇（.csv）+ 可選「起算月份」（預設當月）→ 上傳 → 顯示摘要：
  「建立 N 人 / 更新 N 人 / 新增 N 訂閱 / 跳過 N 訂閱 / 略過 N 列；對不到的方案：[…]」。
- 提示：欄位需為 `姓名, 帳號, <方案名…>`，方案名須與系統方案一致。

---

## 影響的檔案（概要）
- `core/import.ts`（新）：`parseRosterCsv` + `importRoster` + 型別。
- `core/binding.ts`（新，或併入 `core/db.ts`）：`listUnboundUsers(ws)` + `bindDiscordId(env, ws, userId, discordId)`（原子 guarded UPDATE + 結果判定）。
- `adapters/discord/commands.ts`：新增 `BIND_SELECT_PREFIX='chippot:bind'`、`bindSelectRow(ws, users)`、`/綁定` 指令定義（`BIND_COMMAND`）。
- `adapters/discord/handler.ts`：把 `handlePayButton` 解析成功後的繳費提示抽成共用 `buildPayPrompt(env, ws, userId)`；`handlePayButton` 未綁定分流改叫 `origin=pay` 綁定下拉；新增 `/綁定` 指令路由、`handleBindSelect`（IT_COMPONENT，custom_id 前綴分派；`origin=pay` 成功後呼叫 `buildPayPrompt` 接續繳費，`origin=cmd` 僅確認）。
- `routes/admin.ts`：`POST /admin/members/import`；`updateUser` 補 discord_id 衝突的明確錯誤。
- `packages/admin`：匯入名單頁 + api method；成員編輯沿用。
- `scripts/register-commands.mjs`：加 `/綁定` 指令（與 commands.ts 同步）。

## 測試重點
- 綁定：未綁定者按繳費→出 `origin=pay` 綁定下拉（只列未綁定）；選名字→成功寫 discord_id；
  **`origin=pay` 綁定成功→回繳費提示（含渠道下拉）；`origin=cmd` 綁定成功→只確認、無渠道下拉**；
  同帳號二次綁→擋；兩人搶同一名字（target 已綁）→擋；已綁定者按繳費→正常繳費流程。
- `/綁定`：列出未綁定成員；空名單（全綁定）→提示無需綁定。
- 匯入核心：upsert by email（既有保留 discord_id）、多方案展開、冪等重跑、對不到的方案進 unmatchedPlans、
  起算月產生 pending payment（ensureFirstPayment 一致）。
- 匯入路由：摘要正確；audit 寫入。

## 待確認 / 已決定
- (決定) 綁定指認用「選名字下拉」；只列未綁定。綁定成功後：**按鈕進來→自動接續繳費；`/綁定` 進來→只綁定**。
- (決定) 一次性 9 人名單已 SQL 直接載入正式 D1（本 spec 只做可重複功能）。
- (決定) 匯入 upsert key = email；既有成員保留 discord_id；start_date 預設當月。
- (預設，可改) 綁定成功後請成員自行再點繳費，不自動繳。
- (預設，可改) 後台匯入 UI 放在 Settings 頁的「匯入名單」區塊。
