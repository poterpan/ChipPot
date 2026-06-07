# ChipPot 部署指南（部署到你自己的 Cloudflare）

這份文件帶你把 ChipPot 從零部署到**你自己的 Cloudflare 帳號**。照著做完，你會有一個跑在自己網域上的繳費代收／對帳系統。

> 預估時間：30–60 分鐘（多數時間在等 Cloudflare／Discord 後台設定）。

---

## 0. 架構與你會建立的東西

```
Discord  ─┐                               ┌─ D1   (chippot-db)        SQLite 帳本
繳費上傳 ─┼─►  Cloudflare Worker (chippot) ─┤─ R2   (chippot-proofs)    私有截圖
後台 UI  ─┤    core + adapters             └─ Cron（每天 01:00 UTC）   自動開帳/催繳/清理
```

- **1 個 Worker**（`chippot`）：API、Discord 互動、每日 cron。
- **2 個 Pages 專案**：`chippot-web`（公開的繳費上傳頁）、`chippot-admin`（受 Access 保護的後台）。
- **1 個 D1 資料庫**、**1 個 R2 bucket**。
- **1 個 Cloudflare Access application**（保護後台）。
- **1 個 Discord application + bot**。
- 建議 3 個子網域（在你掛在 Cloudflare 的網域底下），例如：
  - `pay.<你的網域>` → 繳費上傳頁
  - `admin.<你的網域>` → 後台（後台 API 也走這個 host 的 `/api/*`）
  - worker 預設網址 `chippot.<你的帳號子網域>.workers.dev`（也可另綁自訂網域）

### 子網域命名與憑證（重要）

子網域**名稱完全可自訂**——`pay.` / `admin.` 只是慣例，要叫什麼都行。只要這幾處填**一致**即可：
`wrangler.toml` 的 `WEB_ORIGIN` / `ADMIN_ORIGIN` / route `pattern`、兩個 Pages 的 Custom domains、
web build 的 `VITE_API_BASE`、以及 Cloudflare Access application 的 domain。

但**層數**有個 SSL 注意點：

- ✅ **一層子網域**（`admin.<網域>`、`pay.<網域>`）：Cloudflare 免費的 Universal SSL 萬用憑證
  `*.<網域>` 直接覆蓋，**零煩惱，建議用這種**。
- ⚠️ **巢狀／兩層子網域**（例如 `admin.chippot.<網域>`）：Universal 萬用字只吃**一層**，
  **不涵蓋** `admin.chippot.<網域>`。Pages 綁自訂網域時會為該確切 host 自動簽憑證（SPA 通常 OK），
  但 worker route 的 host 與 Access 靠邊緣 zone 憑證終止 TLS，可能出現 HTTPS 錯誤。若要用巢狀，請
  開 **Total TLS / Advanced Certificate Manager**（可簽 `*.chippot.<網域>`），或部署後實測 HTTPS 無誤再上。
- 💡 想把品牌歸在 `chippot` 底下又免憑證煩惱：改用獨立網域，例如 `admin.chippot.app` / `pay.chippot.app`
  ——這是 `chippot.app` 的**一層**子網域，Universal SSL 直接覆蓋。

> 巢狀子網域沒有任何**功能**上的好處（route、Access、繳費流程都一樣運作），純粹是命名美觀。

---

## 1. 前置需求

- **Cloudflare 帳號**，且**至少一個網域已託管在 Cloudflare**（要綁子網域與 Worker route 都需要）。
- **Discord 帳號**，且你是某個 Discord 伺服器的管理員。
- 本機安裝 **Node 20+** 與 **[pnpm](https://pnpm.io)**。
- 安裝並登入 Wrangler：
  ```bash
  npm i -g wrangler        # 或用 pnpm dlx wrangler
  wrangler login           # 互動式登入你的 Cloudflare 帳號
  ```

取得程式碼並安裝相依：
```bash
git clone https://github.com/poterpan/ChipPot.git
cd ChipPot
pnpm install
pnpm --filter @chippot/worker test   # （選用）確認測試全綠
```

---

## 2. 建立 Cloudflare 資源（D1 / R2）

```bash
cd packages/worker

# D1 資料庫 → 會回傳一個 database_id，待會要填進 wrangler.toml
wrangler d1 create chippot-db

# R2 bucket（存截圖，私有）
wrangler r2 bucket create chippot-proofs
```

把 `wrangler d1 create` 輸出的 `database_id` 記下來。

> Pages 兩個專案（`chippot-web`／`chippot-admin`）會在第 8 步第一次 `wrangler pages deploy` 時自動建立，這裡先不用動。

---

## 3. 建立 Discord 應用與 Bot

到 <https://discord.com/developers/applications> → **New Application**。

1. **General Information**：複製 **Application ID** → `DISCORD_APPLICATION_ID`，複製 **Public Key** → `DISCORD_PUBLIC_KEY`。
2. **Bot** 分頁：**Reset Token** 取得 **Bot Token** → `DISCORD_BOT_TOKEN`（這是機密，別外洩）。
3. 邀請 bot 進你的伺服器：用 OAuth2 URL Generator，scope 勾 `bot` 與 `applications.commands`，bot 權限至少給 **Send Messages**、**Mention Everyone**（要 tag 身分組）。
4. **Interactions Endpoint URL** 先**留空**——要等第 7 步 worker 部署出網址後再回來填。

另外記下：你的**伺服器（guild）ID**、之後要當「繳費頻道」的**頻道 ID**、各方案對應的**身分組（role）ID**（開啟 Discord 開發者模式後右鍵複製）。這些之後在後台設定，不用現在填。

---

## 4. 設定 Cloudflare Access（保護後台）

後台 `admin.<你的網域>` 整台主機放在 Cloudflare Access 後面（email 驗證）。

1. 進 **Cloudflare Zero Trust** 後台。第一次會請你取一個 **team name**（例如 `myclub`）→ 這就是 `ACCESS_TEAM_DOMAIN`（你的登入網域會是 `myclub.cloudflareaccess.com`）。
2. **Access → Applications → Add an application → Self-hosted**。
   - Application domain 填 `admin.<你的網域>`。
   - 建立後，在該 application 的設定頁複製 **Application Audience (AUD) Tag** → `ACCESS_AUD`。
3. 設 **Policy**：Action = Allow，Include = Emails，填入**允許登入後台的 email**（你自己、其他管理員）。
   > ⚠️ 後台的管理員白名單**就是這條 Access policy**。Worker 端的 `ACCESS_ALLOWED_EMAILS` 目前是停用的（程式裡以 Cloudflare Access 為唯一來源），所以**加／移除後台管理員請改這條 policy**，改完即時生效、不用重新部署。

---

## 5. 修改 `packages/worker/wrangler.toml`

把 repo 內的值換成你自己的。對照表：

| 欄位 | 預設（repo 內，需替換） | 換成 |
|---|---|---|
| `routes[].pattern` | `admin.panspace.dev/api/*` | `admin.<你的網域>/api/*` |
| `routes[].zone_name` | `panspace.dev` | `<你的網域>`（Cloudflare 上的 zone） |
| `[[d1_databases]].database_id` | 一串我們的 id | 第 2 步 `wrangler d1 create` 回傳的 id |
| `[vars] DISCORD_APPLICATION_ID` | 我們的 | 你的（第 3 步） |
| `[vars] DISCORD_PUBLIC_KEY` | 我們的 | 你的（第 3 步） |
| `[vars] WEB_ORIGIN` | `https://pay.panspace.dev` | `https://pay.<你的網域>` |
| `[vars] ADMIN_ORIGIN` | `https://admin.panspace.dev` | `https://admin.<你的網域>` |
| `[vars] ACCESS_TEAM_DOMAIN` | `panspace` | 你的 team name（第 4 步） |
| `[vars] ACCESS_AUD` | 我們的 | 你的 AUD（第 4 步） |
| `[vars] ACCESS_ALLOWED_EMAILS` | 佔位 email | 可留著（目前未使用，見第 4 步說明） |

`name`（worker 名稱）、`database_name`（`chippot-db`）、R2 `bucket_name`（`chippot-proofs`）、`crons`（`0 1 * * *` = 台北每天 09:00）可沿用，想改也行。

---

## 6. 設定 Secret 與 `.dev.vars`

```bash
cd packages/worker

# 機密：Bot Token（存進 Cloudflare，不進 git）
wrangler secret put DISCORD_BOT_TOKEN     # 貼上第 3 步的 token
```

再建一個 `packages/worker/.dev.vars`（已被 gitignore）給「註冊 slash 指令」腳本與本地開發用。直接從範本複製再填值：
```bash
cd packages/worker
cp .dev.vars.example .dev.vars   # 然後填入真實值
```
內容（鍵見 `.dev.vars.example`）：
```
CLOUDFLARE_API_TOKEN=你的-cloudflare-api-token
DISCORD_BOT_TOKEN=你的-bot-token
DISCORD_APPLICATION_ID=你的-application-id
DISCORD_GUILD_ID=你的-guild-id
```
> 註：跑測試（`pnpm test`）**不需要**這個檔——測試會自帶假 token，乾淨 clone／CI 沒有 `.dev.vars` 也能全綠。

---

## 7. 套用 Migration 並部署 Worker

```bash
cd packages/worker

# 套用資料庫 schema（0001…0005）到遠端 D1
wrangler d1 migrations apply chippot-db --remote

# 部署 worker（含 cron 與 admin.<你的網域>/api/* route）
wrangler deploy
```

- 記下輸出的 worker 網址，例如 `https://chippot.<你的帳號子網域>.workers.dev` → 第 8 步的 `VITE_API_BASE` 要用。
- 看到 route 相關的權限警告（`Authentication error code 10000`）通常**非致命**：worker 版本已上線，只是 route 重新宣告需要該 zone 的 Workers Routes 權限。若 route 沒生效，到 Cloudflare 後台手動加一條 Worker route `admin.<你的網域>/api/*` 指向這個 worker 即可。

**回到 Discord 開發者後台**，把 **Interactions Endpoint URL** 設成：`https://<你的 worker 網址>/interactions`（按 Save，Discord 會即時驗證簽章）。

> migration 會帶入一份示範 seed：一個 workspace「社團 AI 訂閱」、3 個示範方案、2 個支付渠道。你可以在後台直接改成自己的。

---

## 8. 部署前端（Cloudflare Pages）

```bash
# 繳費上傳頁（公開）。VITE_API_BASE 一定要指向「你的」worker，否則會打到別人的後端！
cd packages/web
VITE_API_BASE=https://<你的 worker 網址> pnpm build
wrangler pages deploy dist --project-name chippot-web --branch main

# 後台 SPA（同源呼叫 /api，不需設 API base）
cd ../admin
pnpm build
wrangler pages deploy dist --project-name chippot-admin --branch main
```

接著在 **Cloudflare 後台 → 各 Pages 專案 → Custom domains** 綁網域：
- `chippot-web` → `pay.<你的網域>`
- `chippot-admin` → `admin.<你的網域>`

> 後台是「同一個 host 上 Pages + Worker 並存」：`admin.<你的網域>` 由 Pages 提供 SPA，而 `admin.<你的網域>/api/*` 由 Worker 接管（route 優先於 Pages）。所以後台 SPA 用相對路徑 `/api/admin/...` 就能打到 worker，Access JWT 也因同源而帶得到。

---

## 9. 註冊 Discord Slash 指令

```bash
cd packages/worker
DISCORD_GUILD_ID=<你的伺服器ID> pnpm --filter @chippot/worker register
```

註冊 `/繳費`、`/發起繳費`、`/綁定` 三個 guild 指令（讀 `.dev.vars` 的 token/app id）。

---

## 10. 首次設定（登入後台）

打開 `https://admin.<你的網域>`，會先過 Cloudflare Access（輸入你在 policy 允許的 email、收驗證碼）。進入後台後：

1. **設定**頁：
   - **統一結帳日**（例：`1` = 月初整月收費）、**逾期天數**、**截圖保存月數**。
   - **Discord Guild ID**、**繳費頻道 ID**、**可發起繳費的管理員 Discord ID**（逗號分隔）。
   - 三段**通知模板**（逾期催繳／開繳通知／常駐繳費訊息）——有即時預覽與格式檢查。
   - 按「**於 #繳費頻道 建立/重建「繳費」按鈕訊息**」放出常駐繳費按鈕。
2. **方案**：把示範方案改成你的（名稱、月費、provider、身分組 ID）；provider 可直接輸入新的（gemini、glm…）。
3. **支付渠道**：設定你的收款渠道（LINE Pay／銀行轉帳…，類型分行動支付／銀行／其他）。
4. **成員**：手動新增，或在「設定 → 匯入名單」上傳 CSV（姓名, 帳號, 方案名…）。
5. 要開始收款時，「設定 → 發起繳費」對該期別開帳並發出通知（或等每天 09:00 的 cron 自動開帳）。

成員那邊：在 #繳費頻道按「繳費」按鈕（或 `/繳費`）即可繳；沒綁定會先讓他選自己的名字綁定 Discord 帳號。

---

## 11. 常見問題

- **後台顯示「未授權，請重新登入」**：多半是 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` 與你的 Access application 對不上，或登入的 email 不在 Access policy 內。檢查第 4、5 步。
- **繳費上傳頁送出失敗 / CORS**：`VITE_API_BASE`（build 時）要指向你的 worker，且 worker 的 `WEB_ORIGIN` 要等於 `https://pay.<你的網域>`（第 5、8 步）。
- **Discord 指令沒出現**：確認第 9 步用對 guild id，且 bot 已在該伺服器、有 `applications.commands` scope。
- **`/interactions` 驗證失敗**：`DISCORD_PUBLIC_KEY` 要跟你的 application 一致。
- **這個月沒自動開帳**：cron 只在「結帳日當天」開該月帳單（台北 09:00）。想立刻開就用「發起繳費」。
- **加／移除後台管理員**：改 Cloudflare Access 的 policy（不是 wrangler.toml）。

---

## 12. 之後更新版本

```bash
git pull
pnpm install
cd packages/worker && wrangler d1 migrations apply chippot-db --remote   # 若有新 migration
wrangler deploy
cd ../web   && VITE_API_BASE=https://<你的 worker 網址> pnpm build && wrangler pages deploy dist --project-name chippot-web   --branch main
cd ../admin && pnpm build && wrangler pages deploy dist --project-name chippot-admin --branch main
```

有需要可重新 `register` slash 指令（指令有變動時才需要）。
