# R2 改為選填 — 設計

> 日期：2026-06-07　狀態：設計定稿，待寫實作計畫
> 功能 1（兩個體驗優化之一；功能 2「成員/訂閱刪除 CRUD」另立 spec）

## 1. 背景與目標

有些部署者不需要「成員上傳繳費截圖」功能，因此不想註冊 Cloudflare R2。目前 `env.BUCKET`
（R2 binding）是**必填**，程式多處直接使用，未綁 R2 會壞。目標：

1. **R2 變選填**：不註冊 R2 binding 時，整個系統照常運作，只有「截圖佐證」相關功能優雅停用。
2. **後台首次提示**：未設定 R2 時，管理者第一次進後台彈一次提示，說明哪些功能不可用（只彈一次）。
3. **常駐狀態**：設定頁顯示一個常駐的「截圖儲存：未啟用 / 已啟用」狀態，方便日後查看。

**宣告繳費本身不受影響**：選渠道、填備註、後台審核（verify/reject/改金額）、對帳、Discord 開繳/催繳全部照常。

## 2. 關鍵設計決策

- **偵測方式＝binding 是否存在**（`!!env.BUCKET`），不另設 workspace 開關。R2 是基礎設施設定，
  forker 不在 `wrangler.toml` 註冊 `[[r2_buckets]]` 即視為未啟用；零額外狀態、不會「設定說有但實際沒綁」矛盾。
- **無 R2 時截圖一律隱藏/忽略**（成員端），既有「宣告繳費」路徑全程可用。
- **首次提示用 localStorage**（admin SPA 目前未用 localStorage）；只彈一次。

## 3. R2 依賴點與停用後行為

`env.BUCKET` 目前 4 處使用 → 改 `BUCKET?: R2Bucket`（選填）並逐處 guard：

| 位置 | 現行 | 無 R2 時 |
|---|---|---|
| `core/storage.ts` `settleUserPeriod` step 3（存 proof） | `putObject(env.BUCKET, …)` | 有 proof 也跳過儲存，付款宣告照常寫入（`has_proof=0`、`screenshot_key=NULL`），不報錯 |
| `routes/images.ts`（看截圖） | `env.BUCKET.get(key)` | 回 404（截圖功能停用） |
| `routes/admin.ts` `deleteProof` | `env.BUCKET.delete(key)` | 無 BUCKET 或無 proof → 安全 no-op（仍清 DB 欄位） |
| `core/retention.ts`（cron） | `env.BUCKET.delete(...)` | 整段跳過、回 0 |

> `storage.ts` 的 `deleteObject` 補償清理（:201、:219）也在 `if (key)` 內，key 為 null 時自然略過；
> 但因 step 3 已 guard，無 R2 時 key 恆為 null。

## 4. 元件設計

### A. 後端偵測旗標
- `env.ts`：`BUCKET?: R2Bucket`。
- `routes/admin.ts` `getWorkspace`：回應由 `{ workspace }` 擴充為 `{ workspace, r2_configured: !!env.BUCKET }`。
- `routes/upload.ts` `handleUploadInfo`（`GET /upload/:token`）：回應加 `proof_enabled: !!env.BUCKET`。

### B. 成員端截圖 UX
- **web 上傳頁**（`packages/web`）：`TokenInfo` 型別加 `proof_enabled?: boolean`；`App.tsx` 依此**隱藏截圖欄位與相關說明**，只留渠道+備註。`api.ts` 的 `submitPayment` 在停用時不附 `screenshot`。
- **Discord `/繳費`**（`adapters/discord/handler.ts`）：附了截圖但無 R2 → 不傳 proof 給 `settleUserPeriod`（或傳了也被 storage guard 跳過），ephemeral 回覆加一句「本站未開啟截圖功能，已記錄你的繳費宣告」。
- **core 防線**：`settleUserPeriod` step 3 改為 `if (input.proof && env.BUCKET)` 才 `putObject`；這是無論前端如何都成立的單一真相 guard。

### C. 後台首次提示（功能 1b/1c）
- admin SPA 頂層（`App.tsx`）載入後：若 `r2_configured===false` 且 `localStorage.getItem("chippot.r2NoticeSeen")` 不存在 → 顯示一次 Modal。
- Modal 內容：標題「Cloudflare R2 尚未設定」；說明停用的功能（成員上傳/檢視繳費截圖、截圖自動保存清理）；一句「不影響：宣告繳費、後台審核、對帳、Discord 通知」；關閉鈕。
- 關閉時 `localStorage.setItem("chippot.r2NoticeSeen", "1")`，不再彈。

### D. 常駐狀態（功能採納項）
- 設定頁（`views/Settings.tsx`）新增一行常駐狀態：**截圖儲存（R2）：✅ 已啟用 / ⚠️ 未啟用**，由 `api.workspace()` 回的 `r2_configured` 驅動。未啟用時附一句「成員無法上傳截圖；其餘功能正常」。

### E. 設定 / 文件
- `wrangler.toml`：`[[r2_buckets]]` 區塊上方加註解「選填：不需要成員上傳截圖可移除此區塊（R2 未綁時截圖功能自動停用）」。
- `docs/DEPLOY.md`：第 2 節 R2 標為**選填**；新增說明「移除 R2 binding 後，成員上傳/檢視截圖與保存清理停用，其餘照常」。

## 5. 介面 / 檔案異動清單

| 檔案 | 異動 |
|---|---|
| `packages/worker/src/env.ts` | `BUCKET?: R2Bucket`（選填） |
| `packages/worker/src/core/storage.ts` | `settleUserPeriod` step 3 存 proof 加 `&& env.BUCKET` guard |
| `packages/worker/src/routes/images.ts` | 無 BUCKET → 404 |
| `packages/worker/src/routes/admin.ts` | `deleteProof` guard；`getWorkspace` 回 `r2_configured` |
| `packages/worker/src/core/retention.ts` | 無 BUCKET → 跳過、回 0 |
| `packages/worker/src/routes/upload.ts` | `handleUploadInfo` 回 `proof_enabled` |
| `packages/worker/src/adapters/discord/handler.ts` | `/繳費` 無 R2 時忽略附件 + 提示 |
| `packages/web/src/api.ts` | `TokenInfo.proof_enabled`；`submitPayment` 停用時不附截圖 |
| `packages/web/src/App.tsx` | 依 `proof_enabled` 隱藏截圖欄位 |
| `packages/admin/src/api.ts` | `workspace()` 回傳型別加 `r2_configured` |
| `packages/admin/src/App.tsx` | 首次 R2 提示 Modal（localStorage 一次性） |
| `packages/admin/src/views/Settings.tsx` | 常駐 R2 狀態列 |
| `packages/worker/wrangler.toml` | `[[r2_buckets]]` 加「選填」註解 |
| `docs/DEPLOY.md` | R2 標選填 + 停用功能說明 |

## 6. 測試

既有 R2 測試不受影響（vitest 測試環境仍提供 BUCKET binding）。新增（以 `(env as any).BUCKET = undefined` 模擬未綁）：
- `settleUserPeriod`：附 proof 但無 BUCKET → 仍成功結算、`has_proof=0`、`screenshot_key=NULL`、不丟例外。
- `images` 路由：無 BUCKET → 404。
- `retention`：無 BUCKET → 回 0、不呼叫刪除。
- `GET /admin/workspace`：回 `r2_configured`（有 BUCKET=true）；模擬無 BUCKET=false。
- `GET /upload/:token`：回 `proof_enabled` 對應 BUCKET 有無。
- `deleteProof`：無 BUCKET → 仍清 DB 欄位、不丟例外。

> 注意：vitest pool 的 BUCKET 來自設定；逐測試以 save/restore `(env as any).BUCKET` 模擬未綁（沿用既有 token save/restore 範式），避免污染其他測試。

## 7. 風險與權衡

- **既有截圖資料**：本變更只影響「未綁 R2」的部署；已綁 R2 者行為完全不變。
- **Discord slash option**：`/繳費` 的「截圖」option 是靜態註冊、無法依 R2 動態隱藏，故採「忽略附件 + 提示」而非隱藏（已於 §4B 說明）。
- **localStorage 一次性**：清掉瀏覽器儲存會再彈一次；可接受（符合「首次提示」語意）。常駐狀態列提供長期可見性。

## 8. 決議摘要（brainstorming）

1. 偵測：**binding-absence**（`!!env.BUCKET`），不另設開關。
2. 成員截圖：**隱藏/忽略**，宣告繳費照常。
3. 首次提示：**localStorage 一次性 Modal**。
4. **加常駐 R2 狀態列**於設定頁。
5. 與「成員/訂閱刪除 CRUD」分為**兩份獨立 spec/PR**；本 spec 為功能 1。
