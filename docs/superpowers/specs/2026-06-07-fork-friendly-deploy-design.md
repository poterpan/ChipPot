# Fork 友善化部署 — 設計

> 日期：2026-06-07　狀態：設計定稿，待寫實作計畫
> 相關：`docs/DEPLOY.md`、`packages/worker/wrangler.toml`、Codex 複核（2026-06-07）

## 1. 背景與目標

ChipPot 是公開 repo，目標讓**其他開發者 fork 後能輕鬆部署到自己的 Cloudflare**。現行 `docs/DEPLOY.md`
是全手動 wrangler CLI 流程（`d1 create` / `secret put` / `deploy` / `pages deploy` ×2 / 本機 `register`），
對 fork 者門檻高。團隊也偏好用 Cloudflare 網頁介面部署。

參考兩個熱門 Cloudflare 開源專案：
- **miantiao-me/Sink**：Fork → 後台 Workers「Connect to Git」→ 設 build/deploy 指令 → 後台填 env var/secret →
  同步 fork 自動重部署。零本機 CLI。（注意：Sink 仍要 forker 在 `wrangler.jsonc` 填自己的 KV id —— 即
  「改設定檔」本就是參考做法的一部分，不是負分。）
- **cmliu/edgetunnel**：單檔 worker，貼程式碼／上傳 zip／Fork+Pages 連 Git。面積極小。

**目標**：
1. fork 者可走「**本機零工具鏈**」路徑：GitHub 網頁改少量設定 + Cloudflare 後台連 Git 自動部署 + 後台填 secret。
2. **100% 保留**現有純 CLI `wrangler deploy` 全程（owner / 進階使用者用）。
3. 清掉 repo 內所有 owner 正式值（隱私 + 避免 fork 者誤連到 owner 後端）。

**明確非目標**：達到 edgetunnel 等級「真一鍵」。Cloudflare Access、Discord app/bot、自訂子網域 + DNS
是本質性外部設定，任何部署機制都無法自動化——兩條路徑都需手動完成這些。

## 2. 關鍵技術前提（已查證 Cloudflare 文件 2026-06-07）

- **Workers Builds / Pages 後台的「Environment variables」是 _build 期_ 變數**，不會自動成為 Worker 的
  runtime `env`。Worker runtime 變數仍來自 `wrangler.toml [vars]`（由 `wrangler deploy` 套用）。
  → 因此「把 vars 全搬到後台」到不了 runtime，且會與 CLI 流程衝突。**結論：`wrangler.toml` 是 runtime 設定的單一真相來源。**
- **Runtime secret**（`DISCORD_BOT_TOKEN`）：`wrangler secret put`（CLI）或後台 Worker → Settings →
  Variables and Secrets（Git 流程）。**deploy 不會洗掉 secret**。
- **Workers Builds 支援自訂 deploy 指令**（如 `pnpm run deploy`），在 CI 內帶 Cloudflare 認證執行，
  可在其中跑 `wrangler d1 migrations apply --remote`。
- `wrangler d1 migrations apply --remote` **idempotent**：用 `d1_migrations` 表追蹤，只套未套用的 migration。

## 3. 範圍

**In scope**（單一 spec，兩大塊）：
- 讓 repo 對 fork 安全：A（wrangler.toml 佔位值）、B（前端去硬編）、C（slash 註冊後台按鈕）
- 部署機制與文件：D（Git 整合流程 + migration + secret 分層）、E（重寫 DEPLOY.md 雙路徑）

**Out of scope**：CD 到 owner 自己的 prod（維持現狀）、Deploy-to-Cloudflare 按鈕（monorepo + Pages 限制，不適用全棧）、
變更 Access / Discord / DNS 的本質手動性。

---

## 4. 設計

### A. `wrangler.toml` 改佔位值（設定單一真相來源）

`packages/worker/wrangler.toml` 內建 owner 正式值 → 改佔位符 + 清楚註解。

| 欄位 | 現況（owner 正式值，需替換） | 改成 |
|---|---|---|
| `routes[].pattern` / `zone_name` | `admin.panspace.dev/api/*` / `panspace.dev` | `admin.example.com/api/*` / `example.com` |
| `[vars] DISCORD_APPLICATION_ID` | 真實 id | `your-discord-application-id` |
| `[vars] DISCORD_PUBLIC_KEY` | 真實 key | `your-discord-public-key` |
| `[vars] WEB_ORIGIN` | `https://pay.panspace.dev` | `https://pay.example.com` |
| `[vars] ADMIN_ORIGIN` | `https://admin.panspace.dev` | `https://admin.example.com` |
| `[vars] ACCESS_TEAM_DOMAIN` | `panspace` | `your-team-name` |
| `[vars] ACCESS_AUD` | 真實 AUD | `your-access-aud` |
| `[vars] ACCESS_ALLOWED_EMAILS` | `poterpan5466@gmail.com` | **移除整行**（程式已停用此路徑，見 `middleware/access.ts:164-173` 註解；留著只是洩個資） |
| `[[d1_databases]].database_id` | 真實 id | `your-d1-database-id` + 註解「`wrangler d1 create` 或後台建 D1 後填」 |

- 不洩密欄位（`name`、`database_name=chippot-db`、`bucket_name=chippot-proofs`、`crons`、binding 名）沿用。
- **Owner 自己的正式值**：在本機工作目錄把佔位值改回真實值，並用
  `git update-index --skip-worktree packages/worker/wrangler.toml` 讓本機修改不進 commit
  （owner 現已對該檔採此做法——見專案記憶）。CLI 部署照舊，repo 公開乾淨。
  > 注意權衡：skip-worktree 後，若上游改動 `wrangler.toml` 結構，`git pull` 可能需要先暫時取消
  > skip-worktree 再手動併入；這是 owner 端既有的操作成本，可接受。

### B. 移除前端兩處硬編 owner 網域

Codex 揪出、已 grep 驗證：

1. **`packages/web/src/api.ts:1-3`**：`VITE_API_BASE` 未設時**靜默** fallback 到
   `https://chippot.poterpan.workers.dev`（fork 者忘了設就默默打到 owner 後端，不報錯）。
   → **移除 owner URL fallback，改 fail-loud**：未設 `VITE_API_BASE` 時明確報錯（build 期或啟動時），
   不再有 owner 預設值。web 與 worker 跨網域，`VITE_API_BASE` 本就必填。

2. **`packages/admin/src/views/Payments.tsx:235`**：`setLink(\`https://pay.panspace.dev${r.path}\`)` 寫死 owner 網域。
   → **改由 worker 後端產生完整 URL**：`/admin/upload-link`（`routes/admin.ts:~479`，現回傳 `{ token, path, expires_at }`）
   改為同時回傳 `url = \`${env.WEB_ORIGIN}${path}\``（worker 已有 `WEB_ORIGIN` 在 `[vars]`）；前端直接用 `r.url`，
   不再拼網域。一處修正、根除來源。

### C. Slash 註冊：新增後台按鈕（Access 保護路由）

現況：本機 `scripts/register-commands.mjs`（CLI），與「零本機 CLI」衝突。

- **新增** `POST /admin/discord/register-commands`（與其他 `/admin/*` 同樣經 Cloudflare Access 保護）。
  - **import** `PAY_COMMAND` / `INITIATE_COMMAND` / `BIND_COMMAND`（已 export 於 `adapters/discord/commands.ts`）
    作為單一真相，避免與 .mjs 的 inline 副本漂移。
  - 來源齊全：`DISCORD_APPLICATION_ID` 來自 `[vars]`、`DISCORD_BOT_TOKEN` 來自 runtime secret、
    guild id 來自 workspace settings 的 `discord_guild_id`。
  - 對 `PUT https://discord.com/api/v10/applications/{APP_ID}/guilds/{GUILD_ID}/commands` 送出三個 payload（idempotent 覆寫）。
  - 缺 token / guild id 時回明確錯誤（沿用 `discordPaymentMessage` 在 `admin.ts:491` 的 `bot token not configured` 模式）。
- **後台「設定」頁加一顆按鈕**，沿用現有「建立繳費按鈕訊息」的 UI / 錯誤處理。
- **保留** `scripts/register-commands.mjs` 給 CLI 使用者（兩條路並存；兩者都對同一 PUT 端點操作，idempotent）。

### D. 部署流程（兩條路並存）

#### D-1. 三個可部署單位連 Git

| 單位 | 機制 | 指令 | 輸出 |
|---|---|---|---|
| worker | Workers Builds 連 fork | deploy：`pnpm --filter @chippot/worker deploy` | — |
| web（繳費頁，public） | Pages 連 Git | build：`pnpm --filter @chippot/web build` | `packages/web/dist` |
| admin（後台 SPA） | Pages 連 Git | build：`pnpm --filter @chippot/admin build` | `packages/admin/dist` |

- root directory = repo 根（pnpm monorepo；以 `--filter` 指定 package）。
- D1 / R2 可在 Cloudflare 後台點建（Storage & Databases），再用 GitHub 網頁編輯器把 D1 id 填進 `wrangler.toml`。
- fork 者：fork → 後台建 3 個專案連到自己 fork → 填變數 → 同步 fork 自動重部署。本機零工具鏈。

#### D-2. Migration（決議：併進 deploy 自動跑）

- `packages/worker/package.json` 新增 `deploy` script：
  **`wrangler d1 migrations apply chippot-db --remote && wrangler deploy`**。
- Workers Builds 的 deploy 指令指向它（`pnpm --filter @chippot/worker deploy`）。
- 行為：首次部署自動套 0001–0005；之後同步 fork 有新 migration 也自動套；無新 migration 時 no-op（idempotent）。
- CLI 路徑跑同一支 script，行為一致。
- **已知權衡**（Codex）：「migration 成功但 deploy 失敗」會有短暫「新 schema 配舊碼」窗口。對 ChipPot 影響小
  （多為加欄位、可回溯，重 push 即修復）。DEPLOY.md 註明「破壞性 migration 要謹慎、必要時先在低流量時段手動套」。

#### D-3. VITE_API_BASE 雞生蛋 + 順序

- web 需要 worker URL，但 worker URL 部署後才知道 → **部署順序**：先部署 worker → 取得
  `chippot.<子網域>.workers.dev` → 設為 **web 的 Pages build 變數 `VITE_API_BASE`** → 再 build web。
- worker 需要的 `WEB_ORIGIN` / `ADMIN_ORIGIN` 是 fork 者自選網域，開頭就填進 `wrangler.toml`，無雞生蛋。

#### D-4. Secret / 變數分層（文件附此表）

| 名稱 | 類型 | 設定位置（Git 流程 / CLI 流程） | 跨 deploy |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | Worker runtime secret | 後台 Worker → Variables and Secrets ／ `wrangler secret put` | ✅ 保留 |
| `DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY`、`WEB_ORIGIN`、`ADMIN_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` | Worker runtime var | `wrangler.toml [vars]`（兩流程同） | 由 toml 覆寫 |
| `VITE_API_BASE` | Pages build 變數（非 secret） | web 的 Pages 專案 → 設定 → 變數 ／ build 時環境變數 | build 當下 |

#### D-5. 同源 admin route

- `admin.<domain>` 需同時有 **Pages 自訂網域**（提供 SPA）＋ **worker route `admin.<domain>/api/*`**
  （worker 對 `/api/*` 優先於 Pages）。
- DEPLOY.md 講明設定順序（Pages custom domain 與 worker route 都要存在），否則容易只生效一邊。

### E. 重寫 `docs/DEPLOY.md`（雙路徑）

- **路徑一（主推）：Cloudflare 後台 + Git，零本機工具**
  fork → 網頁編輯器改 `wrangler.toml` 佔位值（含 D1 id）→ 後台建 D1/R2 → 連 3 個 Git 專案（1 Workers Builds + 2 Pages）→
  填 build 變數（`VITE_API_BASE`）+ runtime secret（`DISCORD_BOT_TOKEN`）→ 設 Access + Discord app/bot →
  後台按鈕註冊 slash → 首次設定。
- **路徑二（保留）：純 CLI `wrangler`**
  現有全程流程，幾乎不變（值改用本機 overlay）。
- **共用章節**：Cloudflare Access、Discord application/bot、自訂網域/DNS（本質手動，兩路徑都要）。
- 補上：secret 分層表、migration 自動化說明、同源 route 設定順序、`.dev.vars.example`（已存在）指引。

---

## 5. 介面 / 檔案異動清單

| 檔案 | 異動 |
|---|---|
| `packages/worker/wrangler.toml` | `[vars]`/route 改佔位值；移除 `ACCESS_ALLOWED_EMAILS`；`database_id` 佔位 + 註解 |
| `packages/web/src/api.ts` | 移除 owner URL fallback，改未設 `VITE_API_BASE` 即 fail-loud |
| `packages/admin/src/views/Payments.tsx` | 改用後端回傳的 `r.url`，移除硬編 `pay.panspace.dev` |
| `packages/worker/src/routes/admin.ts` | `/admin/upload-link` 回傳新增 `url`；新增 `POST /admin/discord/register-commands` |
| `packages/admin/src/views/`（設定頁） | 新增「註冊 slash 指令」按鈕 |
| `packages/worker/package.json` | 新增 `deploy` script（migrations apply && deploy） |
| `docs/DEPLOY.md` | 重寫為雙路徑 |
| `scripts/register-commands.mjs` | 保留（CLI 用），不動 |

## 6. 測試與驗證

- **既有測試**：worker 測試套件須維持全綠（含「無 `.dev.vars`」的 CI 情境）。新路由
  `register-commands` 比照現有 admin route 加測試（stub fetch、驗證 PUT payload 與授權）；
  `upload-link` 測試斷言回傳含正確 `url`。
- **前端**：`api.ts` fail-loud 行為加測試 / 型別檢查；`web` build 在缺 `VITE_API_BASE` 時應明確失敗。
- **文件驗證**：DEPLOY.md 兩條路徑各走一遍（owner 實機 dry-run 或 checklist 核對）。

## 7. 風險與權衡

- migration 自動套的失敗窗口（見 D-2）——接受，文件警示。
- Workers Builds CI 跑 `--remote` migration 需該 token 具 D1 寫權限——實作時於 owner 帳號實測確認；
  若不足，退路是把 migration 拆成偶發手動步驟（後台 D1 console 或一次性 CLI）。
- 三個 Git 專案連同一 repo——Workers Builds（worker）+ 2×Pages（web/admin），各自 root/build 指令不同，文件需清楚標示。

## 8. 決議摘要（brainstorming）

1. 設定位置：**wrangler.toml 佔位值、直接改**（與 Sink 一致，CLI 完全保留）。
2. slash 註冊：**後台按鈕**（Access 保護路由），保留 CLI 腳本。
3. migration：**併進 deploy 自動跑**（idempotent）。
4. 範圍：A–E 單一 spec。
