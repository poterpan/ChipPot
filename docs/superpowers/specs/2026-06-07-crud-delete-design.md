# 成員/訂閱/方案/渠道 刪除（CRUD 補齊）— 設計

> 日期：2026-06-07　狀態：設計定稿，待寫實作計畫
> 功能 2（兩個體驗優化之二；功能 1「R2 選填」已於 PR #3 合併）

## 1. 背景與目標

目前後台只能新增/編輯成員與訂閱，**無法刪除**——嚴重的 CRUD 缺口（誤建的測試資料、離開的成員都無法移除）。本功能補上刪除能力。

CRUD 缺口 review（feature 2(b) 交付）：掃過所有 admin 路由，缺 `DELETE` 的實體為
**users、subscriptions、plans、channel_tags**（payments 是交易/稽核紀錄，走狀態轉換而非硬刪，刻意保留）。
本功能對四者都補上硬刪除。

**刪除語意決議**：硬刪 + cascade + 前端確認（保留 audit）。訂閱另有既存的「取消」(`status='cancelled'`)
給「停收但留歷史」的情境。

## 2. 關鍵前提（schema）

- 外鍵**無 `ON DELETE CASCADE`**：`subscriptions`→users/plans；`payments`→subscriptions/channel_tags(verified_channel_tag_id)；
  `upload_tokens`→users/subscriptions。`payments` 另有 `declared_channel_tag_id`（migration 0004 新增）也參照 channel_tags。
- `subscriptions.status ∈ ('active','paused','cancelled')`；`payments.status ∈ ('pending','paid','verified','rejected')`。
- `notification_logs`、`audit_logs` 以**值**（非外鍵）記 user_id/subscription_id/entity_id → 刪除時不動（audit 保留刪除紀錄）。
- `payments.screenshot_key` 可能指向 R2 物件（R2 為選填，功能 1）。

## 3. 刪除語意（依實體）

| 實體 | 方式 | 連帶處理（child→parent 順序） |
|---|---|---|
| **user** | cascade 硬刪 | (1) 收集該 user 所有 payments 的 `screenshot_key` → 刪 R2 物件（若 `env.BUCKET`，去重）(2) 刪 payments（`subscription_id IN (該 user 的 subs)`）(3) 刪 `upload_tokens WHERE user_id=?` (4) 刪 `subscriptions WHERE user_id=?` (5) 刪 user |
| **subscription** | cascade 硬刪 | (1) 收集該 sub 的 payments `screenshot_key` → 刪 R2 物件 (2) 刪 payments (3) 刪 `upload_tokens WHERE subscription_id=?` (4) 刪 subscription |
| **plan** | **guarded** 硬刪 | 若 `EXISTS subscriptions WHERE plan_id=?` → 409「此方案仍有訂閱，請先刪除訂閱或改用停用」；否則刪 plan |
| **channel_tag** | **guarded** 硬刪 | 若 `EXISTS payments WHERE verified_channel_tag_id=? OR declared_channel_tag_id=?` → 409「此渠道已被繳費紀錄參照，請改用停用」；否則刪 channel_tag |

- 所有刪除以 workspace 範圍限定（`AND workspace_id = ?`），且實體須屬該 workspace（404 if not）。
- 所有刪除 `writeAudit`：action = `user.delete` / `subscription.delete` / `plan.delete` / `channel_tag.delete`，
  `before` 記主要欄位，`after` 記連帶刪除計數（cascade）或被擋原因。
- 刪除順序為 child→parent，確保即使 D1 強制外鍵也成立。
- R2 物件刪除沿用 `deleteProof` 的 guard 模式（`if (key && env.BUCKET)`）；R2 未綁時略過、不報錯。
  payments 可能共用同一 `screenshot_key`（一次結算多訂閱），故先去重再刪。

## 4. 元件設計

### A. 後端 DELETE 路由（Access 保護，加入 `buildAdminRouter`）
- `DELETE /admin/users/:id` → cascade；回 `{ ok: true, deleted: { subscriptions, payments } }`
- `DELETE /admin/subscriptions/:id` → cascade；回 `{ ok: true, deleted: { payments } }`
- `DELETE /admin/plans/:id` → guarded；成功 `{ ok: true }`，被擋 `errorResponse(409, ...)`
- `DELETE /admin/channel-tags/:id` → guarded；成功 `{ ok: true }`，被擋 409
- 實作放在 `packages/worker/src/routes/admin.ts`（沿用 `wsId(ctx)`、`actorOf(ctx)`、`writeAudit`、`errorResponse`、`json`）。

### B. list 端點加計數（給確認框顯示 + guarded 前端防呆）
- `GET /admin/users`：每列加 `subscription_count`、`payment_count`
- `GET /admin/subscriptions`：每列加 `payment_count`
- `GET /admin/plans`：每列加 `subscription_count`
- `GET /admin/channel-tags`：每列加 `usage_count`（被 payments 參照數，verified 或 declared）
- 以子查詢（COUNT）擴充既有 list SQL；型別同步更新 `packages/admin/src/api.ts` 的 `User`/`Subscription`/`Plan`/`ChannelTag` interface。

### C. 前端（`packages/admin/src/views/Manage.tsx`）
- 各列「編輯」旁加「刪除」鈕。
- **成員/訂閱**：確認 Modal（紅色警示）顯示「將一併刪除 N 個訂閱、M 筆繳費紀錄，**此操作無法復原**」（N/M 來自 list 計數）+ 確認鈕 → `api.deleteUser(id)` / `api.deleteSubscription(id)` → 成功後 reload + 提示。
- **方案/渠道**：`subscription_count`/`usage_count > 0` 時刪除鈕 **disabled** + 提示「使用中，請先停用」；為 0 才可刪 → 確認 → `api.deletePlan(id)` / `api.deleteChannelTag(id)`。
- `packages/admin/src/api.ts` 新增 `deleteUser`/`deleteSubscription`/`deletePlan`/`deleteChannelTag`（`req("DELETE", ...)`）。

## 5. 介面 / 檔案異動清單

| 檔案 | 異動 |
|---|---|
| `packages/worker/src/routes/admin.ts` | 4 個 DELETE handler + router 註冊；4 個 list 查詢加計數 |
| `packages/worker/test/routes/admin.test.ts` | DELETE cascade/guarded/audit/R2 + list 計數測試 |
| `packages/admin/src/api.ts` | 4 個 delete 方法；`User`/`Subscription`/`Plan`/`ChannelTag` 型別加計數欄位 |
| `packages/admin/src/views/Manage.tsx` | 4 區塊各加刪除鈕 + 確認 Modal / guarded disable |

## 6. 測試

worker 測試（`admin.test.ts`，沿用 `call()` 與 seeded workspace 1）：
- **user cascade delete**：建 user+sub+payment(+screenshot_key+putObject)，DELETE → user/sub/payment/upload_token 皆刪、R2 物件刪除、回傳計數正確、`auditCount("user.delete")===1`。
- **subscription cascade delete**：類似，DELETE sub → 其 payments + upload_tokens 刪除，user 保留。
- **plan guarded**：有訂閱 → DELETE 回 409；無訂閱 → 刪除成功 + audit。
- **channel_tag guarded**：被 payment 參照（verified 或 declared）→ 409；未參照 → 刪除成功。
- **R2 未綁時** cascade delete 仍成功（不嘗試刪 R2、不報錯）——以 `(env as any).BUCKET=undefined` 模擬。
- **list 計數**：建立已知數量的 sub/payment 後，GET list 回正確 `*_count`。
- 全程維持「無 `.dev.vars`」綠燈。

前端：`pnpm --filter @chippot/admin typecheck` + `build`。

## 7. 風險與權衡

- **資料不可復原**：cascade 硬刪會刪除財務紀錄；以前端紅色確認框 + audit log 緩解（符合使用者明確選擇的「硬刪 + cascade + 確認」）。訂閱「取消」(status) 保留給需留歷史者。
- **共用 screenshot_key**：去重後再刪 R2，避免重複刪除呼叫；R2 未綁時整段略過。
- **guarded 競態**：plans/channel_tags 的「檢查參照→刪除」非原子；單一管理員後台操作風險極低（YAGNI，不加鎖）。與既有 force-notification 的同模式一致。
- **D1 外鍵**：不論是否強制，child→parent 順序皆安全。

## 8. 決議摘要（brainstorming）

1. 刪除語意：**硬刪 + cascade + 前端確認**（保留 audit；訂閱另有 status=cancelled 軟取消）。
2. 範圍：**四者皆加硬刪**——user/subscription = cascade；plan/channel_tag = guarded（被參照則 409，仍可停用）。
3. cascade 一併刪 R2 截圖物件（依 `env.BUCKET` guard）。
4. list 端點加計數，供確認框顯示與 guarded 前端防呆。
5. 與功能 1 分為獨立 spec/PR；本 spec 為功能 2。
