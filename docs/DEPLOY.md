# ChipPot 部署指南（部署到你自己的 Cloudflare）

這份文件帶你把 ChipPot 從零部署到**你自己的 Cloudflare 帳號**。照著做完，你會有一個跑在自己網域上的繳費代收／對帳系統。

提供**兩條部署路徑**，按需選擇：

| | 路徑一（主推）| 路徑二（CLI）|
|---|---|---|
| 適合 | 想快速 fork、不裝本機工具的使用者 | 喜歡全程 CLI、偏好指令控制的進階用戶 |
| 工具鏈 | 零本機工具（GitHub 網頁編輯器 + Cloudflare 後台）| Node 20+、pnpm、wrangler CLI |
| 更新方式 | GitHub「Sync fork」→ 自動重部署 | `git pull` + `pnpm --filter ... deploy` |

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

所有路徑都需要：

- **Cloudflare 帳號**，且**至少一個網域已託管在 Cloudflare**（要綁子網域與 Worker route 都需要）。
- **Discord 帳號**，且你是某個 Discord 伺服器的管理員。

僅**路徑二（CLI）**額外需要：

- 本機安裝 **Node 20+** 與 **[pnpm](https://pnpm.io)**。
- 安裝並登入 Wrangler：
  ```bash
  npm i -g wrangler        # 或用 pnpm dlx wrangler
  wrangler login           # 互動式登入你的 Cloudflare 帳號
  ```

**路徑一（後台 + Git）無需本機安裝任何工具鏈。**

---

## 2. 建立 Cloudflare 資源（D1 / R2）

### 路徑一（後台操作）

1. 進 [Cloudflare 後台](https://dash.cloudflare.com) → **Storage & Databases → D1**。
2. 建立資料庫，名稱填 `chippot-db`。建立後頁面會顯示 **database_id**（一串 UUID）→ **記下來**，待會填 `wrangler.toml`。
3. 進 **Storage & Databases → R2** → 建立 bucket，名稱填 `chippot-proofs`。

### 路徑二（CLI）

```bash
# D1 資料庫 → 建立後輸出包含 database_id，記下來
wrangler d1 create chippot-db

# R2 bucket（存截圖，私有）
wrangler r2 bucket create chippot-proofs
```

> **兩條路徑都要記下 D1 `database_id`**——第 5 步填 `wrangler.toml` 時需要。

---

## 3. 建立 Discord 應用與 Bot

（兩條路徑共用）

到 <https://discord.com/developers/applications> → **New Application**。

1. **General Information**：複製 **Application ID** → `DISCORD_APPLICATION_ID`，複製 **Public Key** → `DISCORD_PUBLIC_KEY`。
2. **Bot** 分頁：**Reset Token** 取得 **Bot Token** → `DISCORD_BOT_TOKEN`（這是機密，別外洩）。
3. 邀請 bot 進你的伺服器：用 OAuth2 URL Generator，scope 勾 `bot` 與 `applications.commands`，bot 權限至少給 **Send Messages**、**Mention Everyone**（要 tag 身分組）。
4. **Interactions Endpoint URL** 先**留空**——要等第 6 步 worker 部署出網址後再回來填。

另外記下：你的**伺服器（guild）ID**、之後要當「繳費頻道」的**頻道 ID**、各方案對應的**身分組（role）ID**（開啟 Discord 開發者模式後右鍵複製）。這些之後在後台設定，不用現在填。

---

## 4. 設定 Cloudflare Access（保護後台）

（兩條路徑共用）

後台 `admin.<你的網域>` 整台主機放在 Cloudflare Access 後面（email 驗證）。

1. 進 **Cloudflare Zero Trust** 後台。第一次會請你取一個 **team name**（例如 `myclub`）→ 這就是 `ACCESS_TEAM_DOMAIN`（你的登入網域會是 `myclub.cloudflareaccess.com`）。
2. **Access → Applications → Add an application → Self-hosted**。
   - Application domain 填 `admin.<你的網域>`。
   - 建立後，在該 application 的設定頁複製 **Application Audience (AUD) Tag** → `ACCESS_AUD`。
3. 設 **Policy**：Action = Allow，Include = Emails，填入**允許登入後台的 email**（你自己、其他管理員）。
   > ⚠️ 後台的管理員白名單**就是這條 Access policy**。加／移除後台管理員請改這條 policy，改完即時生效、不用重新部署。

---

## 5. 填寫設定（wrangler.toml 佔位值）

`packages/worker/wrangler.toml` 預設是**佔位值**，需換成你自己的。

### 路徑一（GitHub 網頁編輯器）

1. Fork 這個 repo 到你的 GitHub 帳號。
2. 在你的 fork 裡，點開 `packages/worker/wrangler.toml`，用 GitHub 的鉛筆圖示進入網頁編輯器，修改下表中的佔位值後 commit（直接推到 `main` 分支即可）。

### 路徑二（本機直接改）

`git clone` 後直接用文字編輯器修改 `packages/worker/wrangler.toml`。

**Owner 如果不想讓真實值進 git commit（公開 repo 適用）**：改完本機後，執行
```bash
git update-index --skip-worktree packages/worker/wrangler.toml
```
往後這個檔案的修改就不會出現在 `git status` / `git diff`，pull 上游也不會被覆寫。

### 佔位值對照表

| 欄位 | 預設佔位值 | 換成 |
|---|---|---|
| `routes[].pattern` | `admin.example.com/api/*` | `admin.<你的網域>/api/*` |
| `routes[].zone_name` | `example.com` | `<你的網域>`（Cloudflare 上的 zone） |
| `[[d1_databases]].database_id` | `your-d1-database-id` | 第 2 步取得的 D1 database_id |
| `[vars] DISCORD_APPLICATION_ID` | `your-discord-application-id` | 你的（第 3 步） |
| `[vars] DISCORD_PUBLIC_KEY` | `your-discord-public-key` | 你的（第 3 步） |
| `[vars] WEB_ORIGIN` | `https://pay.example.com` | `https://pay.<你的網域>` |
| `[vars] ADMIN_ORIGIN` | `https://admin.example.com` | `https://admin.<你的網域>` |
| `[vars] ACCESS_TEAM_DOMAIN` | `your-team-name` | 你的 team name（第 4 步） |
| `[vars] ACCESS_AUD` | `your-access-aud` | 你的 AUD（第 4 步） |

`name`（worker 名稱 `chippot`）、`database_name`（`chippot-db`）、R2 `bucket_name`（`chippot-proofs`）、`crons`（`0 1 * * *` = 台北每天 09:00）可沿用，想改也行。

> `wrangler.toml` 是**所有 Worker runtime 設定的單一真相來源**。Workers Builds / Pages 後台的「Environment variables」欄位是 build 期變數，**不會**成為 Worker 的 runtime `env`，不要把上表的值填在那裡（`VITE_API_BASE` 是例外，見第 6 步）。

---

## 6. 部署

### 路徑一（主推）：Cloudflare 後台 + Git，零本機工具

#### 6-1. 部署 Worker（Workers Builds）

1. 進 Cloudflare 後台 → **Workers & Pages → Create → Workers Builds（Connect to Git）**。
2. 選擇你的 fork，branch 選 `main`。
3. **Build configuration** 填：
   - Root directory：（留空，repo 根）
   - Build command：`pnpm install`
   - Deploy command：`pnpm --filter @chippot/worker deploy`
4. 儲存並觸發第一次 deploy。

   > **deploy 腳本做兩件事**：先用 `wrangler d1 migrations apply chippot-db --remote` 自動套用所有未套用的 migration（idempotent，冪等），再執行 `wrangler deploy`。首次部署會套入 0001–0005 的初始 schema 與示範 seed。
   >
   > ⚠️ **破壞性 migration**（例如刪欄位、重命名）：建議在低流量時段先在 Cloudflare 後台 D1 console 或 CLI 手動套 migration，確認無誤再推 code 觸發 deploy——避免「新 schema 配舊 worker 程式」的短暫窗口期。

5. 部署成功後，在 Workers Builds 頁或 Worker 的「Triggers」分頁找到 worker 網址，格式為 `https://chippot.<你的帳號子網域>.workers.dev`。**記下這個網址**，後面設 web 的 `VITE_API_BASE` 要用。

6. 設定 **Worker runtime secret**：
   進 Worker → **Settings → Variables and Secrets** → 新增 Secret：
   - Name：`DISCORD_BOT_TOKEN`
   - Value：第 3 步取得的 bot token

   > Secret 跨 deploy 保留，不會被後續部署覆寫。

7. 回到 Discord 開發者後台，把 **Interactions Endpoint URL** 設成：`https://<你的 worker 網址>/interactions`（按 Save，Discord 會即時驗證簽章）。

#### 6-2. 部署 web（繳費上傳頁，Pages）

> ⚠️ **先完成 6-1 再做這步**——web 需要 worker 網址才能設 `VITE_API_BASE`。若未設，繳費頁在瀏覽器載入時會立刻報錯（白屏/console error），這是刻意的 fail-loud 設計。

1. 進 Cloudflare 後台 → **Workers & Pages → Create → Pages（Connect to Git）**。
2. 選你的 fork，branch 選 `main`，Project name 填 `chippot-web`。
3. **Build configuration**：
   - Root directory：（留空）
   - Build command：`pnpm --filter @chippot/web build`
   - Build output directory：`packages/web/dist`
4. **Environment variables（Build variables，僅 build 期）**：
   - 名稱：`VITE_API_BASE`　值：`https://chippot.<你的帳號子網域>.workers.dev`（6-1 第 5 步記下的網址）
5. 儲存並部署。

#### 6-3. 部署 admin（後台 SPA，Pages）

1. 進 Cloudflare 後台 → **Workers & Pages → Create → Pages（Connect to Git）**。
2. 選你的 fork，branch 選 `main`，Project name 填 `chippot-admin`。
3. **Build configuration**：
   - Root directory：（留空）
   - Build command：`pnpm --filter @chippot/admin build`
   - Build output directory：`packages/admin/dist`
4. 無需設 build 變數（admin 與 worker 同源，用相對路徑 `/api/admin/...` 即可）。
5. 儲存並部署。

#### 6-4. 綁自訂網域

**web（繳費頁）：**

進 `chippot-web` Pages → **Custom domains → Set up a custom domain** → 填 `pay.<你的網域>`。

**admin（後台）：同源兩步驟，順序很重要**

admin 頁面需要「Pages SPA」與「Worker API」共存在同一個 hostname 下：

1. 先進 `chippot-admin` Pages → **Custom domains** → 綁 `admin.<你的網域>`（讓 Pages 取得並簽好 SSL 憑證）。
2. 再到 Worker → **Settings → Triggers → Routes** → 新增路由 `admin.<你的網域>/api/*`，指向這個 worker。

> **為什麼這個順序？** Cloudflare 的邊緣會讓 worker route 優先於 Pages，若先加 route 再加 Pages domain，憑證簽發可能卡住。建議先讓 Pages 拿到 custom domain（含憑證），再讓 worker 接管 `/api/*`。
>
> 效果：`admin.<你的網域>` 的 `/api/*` 路徑由 Worker 處理（Access JWT 因同源而帶得到），其餘路徑由 Pages SPA 處理。後台 SPA 用相對路徑 `/api/admin/...` 就能打到 worker，無需另外設 CORS。

#### 6-5. 之後更新

在 GitHub 你的 fork 頁面按 **Sync fork**，Cloudflare Workers Builds 與兩個 Pages 會自動偵測 push、重新 build 並部署（含自動套 migration）。

---

### 路徑二（保留）：純 CLI wrangler

#### 6-1. 取得程式碼並安裝相依

```bash
git clone https://github.com/<你的帳號>/ChipPot.git   # 或原始 repo
cd ChipPot
pnpm install
pnpm --filter @chippot/worker test   # （選用）確認測試全綠
```

#### 6-2. 部署 Worker（含自動套 migration）

確認已完成第 5 步（`wrangler.toml` 填好真實值），然後：

```bash
pnpm --filter @chippot/worker deploy
```

此 deploy 腳本等同於：
```bash
wrangler d1 migrations apply chippot-db --remote && wrangler deploy
```

> migration 冪等，只套未套過的版本。首次會建立完整 schema 與示範 seed。破壞性 migration 請見路徑一 6-1 的注意事項。

記下輸出的 worker 網址（`https://chippot.<你的帳號子網域>.workers.dev`）。

#### 6-3. 設定 Worker runtime secret

```bash
wrangler secret put DISCORD_BOT_TOKEN   # 貼上第 3 步的 token
```

#### 6-4. 設定 Discord Interactions Endpoint URL

回到 Discord 開發者後台，把 **Interactions Endpoint URL** 設成：
`https://<你的 worker 網址>/interactions`

#### 6-5. 部署 web（繳費上傳頁）

```bash
# VITE_API_BASE 一定要指向「你的」worker，否則繳費頁載入即報錯
VITE_API_BASE=https://<你的 worker 網址> pnpm --filter @chippot/web build
wrangler pages deploy packages/web/dist --project-name chippot-web --branch main
```

#### 6-6. 部署 admin（後台 SPA）

```bash
pnpm --filter @chippot/admin build
wrangler pages deploy packages/admin/dist --project-name chippot-admin --branch main
```

#### 6-7. 綁自訂網域

在 Cloudflare 後台：
- `chippot-web` Pages → Custom domains → 綁 `pay.<你的網域>`
- `chippot-admin` Pages → Custom domains → 綁 `admin.<你的網域>`（先綁）
- Worker → Settings → Triggers → Routes → 新增 `admin.<你的網域>/api/*`（後加，確保憑證先就緒）

---

## 7. 註冊 Discord Slash 指令

（兩條路徑）

### 路徑一（後台按鈕）

登入後台 → **設定** 頁 → 點「**註冊 / 更新 Discord slash 指令**」按鈕。

### 路徑二（CLI）

```bash
cd packages/worker
DISCORD_GUILD_ID=<你的伺服器ID> pnpm --filter @chippot/worker register
```

> 兩者都對相同的 Discord API 端點（`PUT .../guilds/{GUILD_ID}/commands`）做 idempotent 覆寫，效果等同。
> 此步驟會註冊 `/繳費`、`/發起繳費`、`/綁定` 三個 guild 指令。

---

## 8. 首次設定（登入後台）

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

## 9. 變數 / Secret 分層速查表

| 名稱 | 類型 | 設定位置（路徑一 後台 / 路徑二 CLI） | 跨 deploy |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | Worker runtime secret | 後台 Worker → Settings → Variables and Secrets ／ `wrangler secret put` | 保留 |
| `DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY`、`WEB_ORIGIN`、`ADMIN_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` | Worker runtime var | `wrangler.toml [vars]`（兩路徑相同） | 由 toml 覆寫 |
| `VITE_API_BASE` | Pages build 變數（非 secret） | web 的 Pages 專案 → 設定 → 變數（路徑一）／ build 時環境變數（路徑二） | build 當下 |

> **重要**：Workers Builds / Pages 後台的「Environment variables」欄位是 **build 期**變數，**不會**注入 Worker 的 runtime `env`。Worker 的 runtime vars 只來自 `wrangler.toml [vars]`；secrets 只來自 `wrangler secret put` 或後台 Variables and Secrets 頁面。

---

## 10. 常見問題

- **後台顯示「未授權，請重新登入」**：多半是 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` 與你的 Access application 對不上，或登入的 email 不在 Access policy 內。檢查第 4、5 步。
- **繳費上傳頁載入即報錯（白屏 / console error）**：`VITE_API_BASE` 未設定，繳費頁會立刻 fail-loud——這是刻意設計，避免打到別人的後端。確認 web 的 Pages build 變數 `VITE_API_BASE` 已正確設為你的 worker 網址。
- **繳費上傳頁送出失敗 / CORS**：`VITE_API_BASE`（build 期）要指向你的 worker，且 worker 的 `WEB_ORIGIN` 要等於 `https://pay.<你的網域>`（第 5、6 步）。
- **Discord Slash 指令沒出現**：確認第 7 步用對 guild id、bot 已在伺服器且有 `applications.commands` scope；可再按一次設定頁的「註冊 / 更新」按鈕，或重跑 CLI `register`。
- **`/interactions` 驗證失敗**：`DISCORD_PUBLIC_KEY` 要跟你的 application 一致（`wrangler.toml [vars]`）。
- **這個月沒自動開帳**：cron 只在「結帳日當天」開該月帳單（台北 09:00 = 01:00 UTC）。想立刻開就用「發起繳費」。
- **加／移除後台管理員**：改 Cloudflare Access 的 policy（不是 `wrangler.toml`），改完即時生效。
- **路徑一 worker route 添加出現 `Authentication error 10000`**：通常是 Workers Builds 使用的 API token 缺 Workers Routes 權限（非致命，worker 版本已上線）。若 route 沒生效，到 Cloudflare 後台手動在 Worker → Settings → Triggers → Routes 新增即可。

---

## 11. 之後更新版本

### 路徑一（自動）

在 GitHub 你的 fork 頁面按 **Sync fork** → Cloudflare 自動偵測 push → Workers Builds 重部署 worker（含自動套 migration）→ 兩個 Pages 重 build。全程無需本機操作。

> 若新版 migration 是**破壞性**的，建議先在後台 D1 console 手動套完、確認無誤，再按 Sync fork 觸發程式更新。

### 路徑二（CLI）

```bash
git pull
pnpm install
pnpm --filter @chippot/worker deploy          # 含自動套 migration

VITE_API_BASE=https://<你的 worker 網址> pnpm --filter @chippot/web build
wrangler pages deploy packages/web/dist --project-name chippot-web --branch main

pnpm --filter @chippot/admin build
wrangler pages deploy packages/admin/dist --project-name chippot-admin --branch main
```

指令有新增變動時，重新執行第 7 步的 `register` 更新 guild 指令。
