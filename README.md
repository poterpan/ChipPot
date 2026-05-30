# ChipPot

訂閱代管收費系統 — 100% serverless on Cloudflare。社團 AI 訂閱（OpenAI / Anthropic）代收、
對帳、繳費管理。核心層 / 管道 adapter 層分離（本期 Discord，預留 LINE/Telegram），
資料模型支援多帳本（workspace）。

## Live

| 部分 | 網址 |
|---|---|
| Worker API + Discord interactions + Cron | https://chippot.poterpan.workers.dev |
| 繳費上傳頁（公開，token-gated） | https://pay.panspace.dev |
| 管理後台（Cloudflare Access） | https://admin.panspace.dev |

資源與佈建狀態（D1 / R2 / Access AUD / Discord ids）記錄於 **`docs/deploy-state.md`**。
規格→計畫在 `docs/superpowers/plans/`。

## 架構

```
Discord ─┐                         ┌─ D1 (chippot-db)
Web 上傳 ─┼─► Cloudflare Worker ───┤
Admin UI ─┤   (核心層 + adapters)   └─ R2 (chippot-proofs, private)
Cron ────┘
```
- **核心層** `src/core/*`：與管道無關 — time(Asia/Taipei) · tokens · audit · payments(狀態機) ·
  billing · reconcile · storage(R2+補償) · notify · scheduled · retention。
- **Discord adapter** `src/adapters/discord/*`：Ed25519 驗章、`/繳費` 互動、按鈕、通知。
- **Routes** `src/routes/*`：`/admin/*`(Access) · `/upload`(token) · `/images`(受保護) · `/interactions`(Ed25519)。
- **前端**：`packages/web`(上傳頁) · `packages/admin`(後台 SPA)，皆 Vite+React → Cloudflare Pages。

### 管理後台的 Access 模型
`admin.panspace.dev` 整個主機由 Cloudflare Access 保護（登入寄 OTP 到允許的 email）。
SPA 在 Pages；後台 API 用 **Worker route `admin.panspace.dev/api/*`** 回到同一個 worker
（worker 去除 `/api` 前綴）。同源 → Access JWT(`Cf-Access-Jwt-Assertion`) 會到 worker，
`requireAccess` 驗 aud/iss/exp + email allowlist。看截圖走同源受保護端點，`<img>` 直接可用。

## 開發

```bash
pnpm install
pnpm --filter @chippot/worker test          # 103 tests (Vitest + Miniflare 真 D1/R2)
pnpm --filter @chippot/worker typecheck
pnpm --filter @chippot/worker dev            # 本地 wrangler dev
pnpm --filter @chippot/web build             # 上傳頁
pnpm --filter @chippot/admin build           # 後台
```
測試慣例（每個 DB 測試）：storage 隔離是**每檔案**級；Miniflare D1 強制 FK；變更型測試用
獨立 id 空間（9001+）。

## 部署

```bash
# Worker（含 cron trigger 與 admin.panspace.dev/api 路由）
cd packages/worker && wrangler deploy
# 上傳頁 / 後台
cd packages/web   && pnpm build && wrangler pages deploy dist --project-name chippot-web --branch main
cd packages/admin && pnpm build && wrangler pages deploy dist --project-name chippot-admin --branch main
# D1 migration
wrangler d1 migrations apply chippot-db --remote
```

### Secrets / vars
- Secret：`DISCORD_BOT_TOKEN`（`wrangler secret put`）。本地放 `packages/worker/.dev.vars`（gitignored）。
- Vars（`wrangler.toml`，非機密）：`DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY`、
  `WEB_ORIGIN`、`ADMIN_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ACCESS_ALLOWED_EMAILS`。
- Discord 端設定：interactions endpoint = worker `/interactions`；`/繳費` 註冊於測試 guild。

## 操作

- **新增成員/訂閱**：後台 → 成員 / 訂閱（建立訂閱會立即建第一期 payment）。
- **審核繳費**：後台 → 繳費審核 → 開單筆看截圖 → 標 verified（選渠道 tag）/ 退回 / 改金額 / 刪截圖。
- **手動補登 / 代繳**：繳費審核 → 手動補登（source=admin_manual）。
- **產生上傳連結**：繳費審核 → 產生上傳連結（30 分鐘、一次性、貼給對方）。
- **常駐繳費按鈕**：後台 → 設定 → 建立/重建繳費訊息（或 `POST /admin/discord/payment-message`）。
- **Cron**：每日 01:00 UTC（=09:00 台北）— 冪等建當期 payment、開繳通知(tag 身分組)、
  逾期提醒(tag 個人)、截圖 retention 刪圖。皆經 `notification_logs` 去重。
- **收費入口**：① Discord 常駐「繳費」按鈕 → 上傳頁；② `/繳費`(可附截圖或留備註，至少一項)；
  ③ 後台手動產生連結。

## 已知後續（本期不實作，留接口）
多帳本 workspace 切換 UI、LINE/Telegram adapter、orphan R2 清理 cron、`plans.billing_cycle`(年繳)/`split_count`(分攤)。
