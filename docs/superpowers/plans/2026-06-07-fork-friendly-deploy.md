# Fork 友善化部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 fork 者能用「本機零工具鏈」的 Cloudflare 後台 + Git 流程部署 ChipPot，同時 100% 保留純 CLI `wrangler deploy`，並清除 repo 內所有 owner 正式值。

**Architecture:** `wrangler.toml` 維持 runtime 設定的單一真相來源（改佔位值，owner 用 skip-worktree 保留本機真值）；移除前端兩處硬編 owner 網域；slash 指令註冊改由 Access 保護的後台按鈕觸發（沿用既有 `registerGuildCommands` helper）；worker 加 `deploy` script 把 migration 併進部署；DEPLOY.md 重寫為雙路徑。

**Tech Stack:** Cloudflare Workers + D1 + R2 + Pages，pnpm monorepo，TypeScript，Vitest（`@cloudflare/vitest-pool-workers`），React SPA（Vite）。

**Spec:** `docs/superpowers/specs/2026-06-07-fork-friendly-deploy-design.md`

**前置：** 本計畫的分支為 `deploy/fork-friendly-deploy`（已 off 最新 main）。每個 Task 結束 commit。全程基準：`pnpm -r typecheck`、`pnpm --filter @chippot/worker test`、`pnpm -r build` 須維持綠燈；worker 測試在「無 `.dev.vars`」下也須全綠（CI 條件）。

---

## File Structure

| 檔案 | 責任 | Task |
|---|---|---|
| `packages/worker/wrangler.toml` | runtime 設定來源 → 佔位值 | 1 |
| `packages/worker/src/index.ts` | 註解去 owner 網域 | 1 |
| `packages/worker/test/index.test.ts` | 測試標題去 owner 網域 | 1 |
| `packages/worker/src/routes/admin.ts` | upload-link 回傳 `url`；新增 register-commands 路由 | 2, 4 |
| `packages/worker/test/routes/admin.test.ts` | upload-link `url`、register-commands 測試 | 2, 4 |
| `packages/admin/src/api.ts` | `uploadLink` 型別加 `url`；新增 `registerCommands` | 2, 4 |
| `packages/admin/src/views/Payments.tsx` | 改用後端 `url`，去硬編 | 2 |
| `packages/admin/src/views/Settings.tsx` | 新增「註冊 slash 指令」按鈕 | 4 |
| `packages/web/src/api.ts` | 移除 owner URL fallback，改 fail-loud | 3 |
| `packages/worker/package.json` | 新增 `deploy` script（migrations && deploy） | 5 |
| `docs/DEPLOY.md` | 重寫雙路徑 | 6 |

---

## Task 1: `wrangler.toml` 佔位值 + owner 值清除

**Files:**
- Modify: `packages/worker/wrangler.toml`
- Modify: `packages/worker/src/index.ts:31`（註解）
- Modify: `packages/worker/test/index.test.ts:21`（測試標題）

- [ ] **Step 1: 改 `wrangler.toml` 為佔位值**

把 `packages/worker/wrangler.toml` 全文改成（移除 `ACCESS_ALLOWED_EMAILS`、route/vars/database_id 改佔位、加指引註解）：

```toml
name = "chippot"
main = "src/index.ts"
compatibility_date = "2025-11-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

# 後台 API 與 admin SPA 同源（同 hostname 下 worker route 優先於 Pages，對 /api/* 生效）。
# 換成你自己的網域與 Cloudflare zone：
routes = [
  { pattern = "admin.example.com/api/*", zone_name = "example.com" },
]

[[d1_databases]]
binding = "DB"
database_name = "chippot-db"
# 執行 `wrangler d1 create chippot-db`（或在 Cloudflare 後台建 D1）後，把回傳的 id 填這裡：
database_id = "your-d1-database-id"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "chippot-proofs"

# 非機密的 Discord / Access 設定（公開值）。Bot token 是 secret，用 `wrangler secret put DISCORD_BOT_TOKEN`
# 或後台 Worker → Settings → Variables and Secrets 設定，不寫在這裡。
[vars]
DISCORD_APPLICATION_ID = "your-discord-application-id"
DISCORD_PUBLIC_KEY = "your-discord-public-key"
WEB_ORIGIN = "https://pay.example.com"
ADMIN_ORIGIN = "https://admin.example.com"
ACCESS_TEAM_DOMAIN = "your-team-name"
ACCESS_AUD = "your-access-aud"

# 01:00 UTC = 09:00 Asia/Taipei，每天。
[triggers]
crons = ["0 1 * * *"]
```

- [ ] **Step 2: 去除 `src/index.ts` 註解內的 owner 網域**

`packages/worker/src/index.ts:31` 註解 `admin.panspace.dev/api/*` → 改為 `admin.example.com/api/*`：

找到該行（內容類似）：
```ts
    // admin.panspace.dev/api/* routes to this worker; strip /api so the same routers match.
```
改成：
```ts
    // admin.example.com/api/* routes to this worker; strip /api so the same routers match.
```

- [ ] **Step 3: 去除測試標題內的 owner 網域**

`packages/worker/test/index.test.ts:21` 標題：
```ts
  it("strips /api prefix (admin.panspace.dev/api/* -> /admin/*)", async () => {
```
改成：
```ts
  it("strips /api prefix (admin.example.com/api/* -> /admin/*)", async () => {
```

- [ ] **Step 4: 確認 repo 內已無 owner 正式值殘留（wrangler.toml 範圍）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
grep -rn "panspace\|poterpan5466\|chippot.poterpan.workers.dev" packages/worker/wrangler.toml packages/worker/src packages/worker/test
```
Expected: 無輸出（前端的兩處 panspace 在 Task 2/3 處理，這裡只確認 worker 範圍乾淨）。

- [ ] **Step 5: 跑 typecheck + 測試（含無 .dev.vars 情境）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm --filter @chippot/worker test 2>&1 | grep -E "Test Files|Tests "
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 無錯；`Test Files  31 passed (31)`、`Tests  158 passed (158)`。

- [ ] **Step 6: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/wrangler.toml packages/worker/src/index.ts packages/worker/test/index.test.ts
git commit -m "chore(worker): replace owner values in wrangler.toml with placeholders

Make the repo fork-safe: routes/vars/database_id become placeholders with
guidance comments; remove ACCESS_ALLOWED_EMAILS (the code path is disabled —
Access policy is the real allowlist — so it only leaked an email). Also
genericize two cosmetic panspace.dev references (index.ts comment, test title).
Owner keeps real values locally via git update-index --skip-worktree."
```

---

## Task 2: upload-link 回傳完整 `url`（去 admin 硬編）

**Files:**
- Modify: `packages/worker/src/routes/admin.ts:479`（`createUploadLink` 回傳）
- Test: `packages/worker/test/routes/admin.test.ts:70-75`（既有測試加斷言）
- Modify: `packages/admin/src/api.ts:60`（`uploadLink` 回傳型別加 `url`）
- Modify: `packages/admin/src/views/Payments.tsx:234-235`（用 `r.url`）

- [ ] **Step 1: 在既有測試加 `url` 斷言（先失敗）**

`packages/worker/test/routes/admin.test.ts`，在第 70-75 區塊（取得 `link` 後）加入兩行斷言。原本：
```ts
    const link = (await lRes!.json()) as any;
    const tok = await findValidUploadToken(env.DB, await hashToken(link.token), nowUtcIso());
    expect(tok?.user_id).toBe(userId);
    expect(tok?.period).toBe("2026-07");
```
改成（新增 url 斷言）：
```ts
    const link = (await lRes!.json()) as any;
    // url is a full absolute link built from WEB_ORIGIN, ending in the token path (no hardcoded domain).
    expect(link.url).toMatch(/^https?:\/\/.+\/u\/.+$/);
    expect(link.url.endsWith(link.path)).toBe(true);
    const tok = await findValidUploadToken(env.DB, await hashToken(link.token), nowUtcIso());
    expect(tok?.user_id).toBe(userId);
    expect(tok?.period).toBe("2026-07");
```

- [ ] **Step 2: 跑測試確認失敗**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "url|FAIL|Tests "
```
Expected: 失敗（`link.url` 為 undefined，`toMatch` 失敗）。

- [ ] **Step 3: 讓 `createUploadLink` 回傳 `url`**

`packages/worker/src/routes/admin.ts`，`createUploadLink` 結尾的 return（第 479 行）。原本：
```ts
  return json({ token: raw, path: `/u/${raw}`, expires_at: expiresAt }, { status: 201 });
```
改成（用 `WEB_ORIGIN` 組完整 URL；去尾斜線避免雙斜線）：
```ts
  const path = `/u/${raw}`;
  const webOrigin = (env.WEB_ORIGIN ?? "").replace(/\/$/, "");
  return json({ token: raw, path, url: `${webOrigin}${path}`, expires_at: expiresAt }, { status: 201 });
```

- [ ] **Step 4: 跑測試確認通過**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "Tests "
```
Expected: `Tests  ... passed`（全綠）。

- [ ] **Step 5: admin client 型別加 `url`**

`packages/admin/src/api.ts:60`，原本：
```ts
  uploadLink: (b: unknown) => req<{ token: string; path: string; expires_at: string }>("POST", "/upload-link", b),
```
改成：
```ts
  uploadLink: (b: unknown) => req<{ token: string; path: string; url: string; expires_at: string }>("POST", "/upload-link", b),
```

- [ ] **Step 6: Payments.tsx 改用 `r.url`，移除硬編**

`packages/admin/src/views/Payments.tsx:234-235`，原本：
```tsx
      const r = await api.uploadLink({ user_id: Number(userId), period });
      setLink(`https://pay.panspace.dev${r.path}`);
```
改成：
```tsx
      const r = await api.uploadLink({ user_id: Number(userId), period });
      setLink(r.url);
```

- [ ] **Step 7: typecheck（worker + admin）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck && pnpm --filter @chippot/admin typecheck
```
Expected: 兩者皆無錯。

- [ ] **Step 8: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts packages/admin/src/api.ts packages/admin/src/views/Payments.tsx
git commit -m "fix(admin): build upload link from WEB_ORIGIN, drop hardcoded owner domain

The admin 'copy upload link' feature hardcoded https://pay.panspace.dev. Have the
worker return a full url built from WEB_ORIGIN; the admin SPA uses it verbatim, so
a fork's links point at the fork's own domain."
```

---

## Task 3: web `api.ts` fail-loud（移除 owner URL fallback）

**Files:**
- Modify: `packages/web/src/api.ts:1-3`

- [ ] **Step 1: 移除 owner fallback，改成未設即拋錯**

`packages/web/src/api.ts` 第 1-3 行，原本：
```ts
const API =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "https://chippot.poterpan.workers.dev";
```
改成：
```ts
const API = import.meta.env.VITE_API_BASE as string | undefined;
if (!API) {
  // Fail loud instead of silently calling someone else's backend: a fork that forgot to set
  // VITE_API_BASE at build time would otherwise post payments to the upstream worker.
  throw new Error(
    "VITE_API_BASE is not set. Build the web app with it pointing at your worker, e.g. " +
      "VITE_API_BASE=https://chippot.<your-subdomain>.workers.dev pnpm --filter @chippot/web build"
  );
}
```

- [ ] **Step 2: typecheck（確認 narrowing 後 `API` 為 string，後續 `${API}` 不報錯）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/web typecheck
```
Expected: 無錯（控制流narrowing 後 `API: string`）。

- [ ] **Step 3: build 驗證（有設 VITE_API_BASE 應成功）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build 2>&1 | tail -3
```
Expected: build 成功（`✓ built in ...`）。

- [ ] **Step 4: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/web/src/api.ts
git commit -m "fix(web): fail loud when VITE_API_BASE is unset

Remove the hardcoded fallback to the owner's worker URL. A fork that forgets to set
VITE_API_BASE at build time now errors immediately instead of silently routing the
public payment page to the upstream backend."
```

---

## Task 4: slash 指令註冊後台按鈕（Access 保護路由）

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`（imports、新 handler、router 註冊）
- Test: `packages/worker/test/routes/admin.test.ts`（新 describe 區塊）
- Modify: `packages/admin/src/api.ts`（新 `registerCommands`）
- Modify: `packages/admin/src/views/Settings.tsx`（新 `RegisterCommands` 元件 + 渲染）

- [ ] **Step 1: 寫失敗測試（新路由）**

`packages/worker/test/routes/admin.test.ts`，在 `describe("admin notifications", ...)` 區塊之後（檔案靠後處、最後一個 top-level `describe` 前）新增：
```ts
describe("admin discord slash registration", () => {
  it("registers the three guild commands via the Discord API", async () => {
    // guild id lives in workspace settings; bot token is a runtime secret.
    await call("PATCH", "/admin/workspace", { settings: { discord_guild_id: "guild-777" } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    let captured: { url: string; body: any } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response("[]", { status: 200 });
    }));
    const res = await call("POST", "/admin/discord/register-commands");
    vi.unstubAllGlobals();
    (env as any).DISCORD_BOT_TOKEN = prevToken;

    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).registered).toBe(3);
    expect(captured!.url).toContain("/guilds/guild-777/commands");
    const names = captured!.body.map((c: any) => c.name);
    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(["繳費", "發起繳費", "綁定"])); // order-independent
  });

  it("400s when the bot token is not configured", async () => {
    await call("PATCH", "/admin/workspace", { settings: { discord_guild_id: "guild-777" } });
    const prevToken = (env as any).DISCORD_BOT_TOKEN;
    delete (env as any).DISCORD_BOT_TOKEN;
    const res = await call("POST", "/admin/discord/register-commands");
    (env as any).DISCORD_BOT_TOKEN = prevToken;
    expect(res!.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker test test/routes/admin.test.ts 2>&1 | grep -E "slash|FAIL|register|Tests "
```
Expected: 失敗（路由不存在 → 404，斷言 200 失敗）。

- [ ] **Step 3: 加 imports（admin.ts 頂部）**

`packages/worker/src/routes/admin.ts:11-12`，原本：
```ts
import { createChannelMessage, editChannelMessage } from "../adapters/discord/api";
import { payButtonRow } from "../adapters/discord/commands";
```
改成：
```ts
import { createChannelMessage, editChannelMessage, registerGuildCommands } from "../adapters/discord/api";
import { payButtonRow, PAY_COMMAND, INITIATE_COMMAND, BIND_COMMAND } from "../adapters/discord/commands";
```

- [ ] **Step 4: 新增 handler（接在 `discordPaymentMessage` 之後，約第 510 行）**

在 `discordPaymentMessage` 函式結束 `}` 之後、`// ── Router ──` 之前插入：
```ts
async function discordRegisterCommands(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
  if (!row) return errorResponse(404, "not found");
  const settings = parseSettings(row.settings);
  const guildId = settings.discord_guild_id;
  if (!guildId) return errorResponse(400, "discord_guild_id is not set");
  if (!env.DISCORD_APPLICATION_ID) return errorResponse(400, "DISCORD_APPLICATION_ID is not set");
  if (!env.DISCORD_BOT_TOKEN) return errorResponse(400, "bot token not configured");

  const commands = [PAY_COMMAND, INITIATE_COMMAND, BIND_COMMAND];
  const res = await registerGuildCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID, guildId, commands);
  if (!res.ok) return errorResponse(502, "failed to register commands");

  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "discord.register_commands", entityType: "workspace", entityId: ws, after: { guild_id: guildId, count: commands.length } });
  return json({ ok: true, registered: commands.length });
}
```

- [ ] **Step 5: 註冊路由**

`packages/worker/src/routes/admin.ts:543`，原本最後一行：
```ts
    .post("/admin/discord/payment-message", discordPaymentMessage);
```
改成：
```ts
    .post("/admin/discord/payment-message", discordPaymentMessage)
    .post("/admin/discord/register-commands", discordRegisterCommands);
```

- [ ] **Step 6: 跑測試確認通過（含無 .dev.vars）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm --filter @chippot/worker test 2>&1 | grep -E "Test Files|Tests "
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: `Test Files  31 passed (31)`、`Tests  160 passed (160)`（新增 2 個測試）。

- [ ] **Step 7: admin client 加 `registerCommands`**

`packages/admin/src/api.ts`，在 `rebuildPaymentMessage`（第 47 行）之後加一行：
```ts
  registerCommands: () => req<{ ok: boolean; registered: number }>("POST", "/discord/register-commands"),
```

- [ ] **Step 8: Settings.tsx 新增 `RegisterCommands` 元件**

`packages/admin/src/views/Settings.tsx`，在 `RebuildMessage` 函式（結束於第 230 行 `}`）之後新增：
```tsx
function RegisterCommands() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.registerCommands(); setMsg(`✓ 已註冊 ${r.registered} 個 slash 指令`); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <button className="btn" onClick={run} disabled={busy}>註冊 / 更新 Discord slash 指令（/繳費、/發起繳費、/綁定）</button>
    </>
  );
}
```

- [ ] **Step 9: 在設定頁渲染新按鈕**

`packages/admin/src/views/Settings.tsx:122-124`，原本：
```tsx
        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">常駐繳費訊息</div>
        <RebuildMessage />
```
改成（在 RebuildMessage 後加一段 slash 指令區塊）：
```tsx
        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">常駐繳費訊息</div>
        <RebuildMessage />

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">Discord slash 指令</div>
        <RegisterCommands />
```

- [ ] **Step 10: typecheck（worker + admin）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/worker typecheck && pnpm --filter @chippot/admin typecheck
```
Expected: 兩者皆無錯。

- [ ] **Step 11: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts packages/admin/src/api.ts packages/admin/src/views/Settings.tsx
git commit -m "feat(admin): register Discord slash commands from a dashboard button

Add an Access-protected POST /admin/discord/register-commands that PUTs the three
guild commands via the existing registerGuildCommands helper (app id from vars,
guild id from settings, bot token from the runtime secret), plus a Settings-page
button. Lets zero-CLI forkers register slash commands; the pnpm register script
stays for CLI users."
```

---

## Task 5: worker `deploy` script（migration 併進部署）

**Files:**
- Modify: `packages/worker/package.json`

- [ ] **Step 1: 加 `deploy` script**

`packages/worker/package.json` 的 `scripts` 區塊，在 `"deploy": "wrangler deploy"` 這行（若已存在則取代）設為先套 migration 再部署。把：
```json
    "deploy": "wrangler deploy",
```
改成：
```json
    "deploy": "wrangler d1 migrations apply chippot-db --remote && wrangler deploy",
```

- [ ] **Step 2: 確認 script 語法正確（dry-check，不實際部署）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
node -e "const s=require('./packages/worker/package.json').scripts.deploy; console.log(s); if(!s.includes('migrations apply')||!s.includes('wrangler deploy'))process.exit(1)"
```
Expected: 印出 `wrangler d1 migrations apply chippot-db --remote && wrangler deploy`，exit 0。

> 注意：實際 `--remote` 部署需 Cloudflare 認證，於部署階段在 owner 帳號驗證（見 spec §7：確認 Workers Builds 的 CI token 具 D1 寫權限；若不足則退回 migration 偶發手動）。本步驟只驗證 script 字串。

- [ ] **Step 3: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add packages/worker/package.json
git commit -m "build(worker): fold D1 migrations into the deploy script

deploy now runs 'wrangler d1 migrations apply chippot-db --remote && wrangler deploy'
so both CLI and Workers Builds apply pending migrations before deploying (idempotent:
wrangler tracks applied migrations)."
```

---

## Task 6: 重寫 `docs/DEPLOY.md`（雙路徑）

**Files:**
- Modify: `docs/DEPLOY.md`（重寫）

> 沿用現有 DEPLOY.md 的共用素材（架構圖、子網域 SSL 說明、Access、Discord app、首次設定、FAQ）與 spec §4D/E。重寫成「兩條部署路徑 + 共用前置/後置」結構。

- [ ] **Step 1: 重寫 DEPLOY.md 成下列結構（保留既有共用章節的內容，調整部署章節）**

新結構（章節標題與要點；共用章節沿用現有文字，僅把 owner 範例網域改成 `example.com` 佔位）：

```
# ChipPot 部署指南

## 0. 架構與你會建立的東西        ← 沿用現有（worker + 2 Pages + D1 + R2 + Access + Discord）
## 1. 前置需求                    ← Cloudflare 帳號 + 已託管網域；Discord 帳號
                                    （路徑一不需本機 Node/pnpm/wrangler；路徑二才需要）

## 2. 建立 Cloudflare 資源（D1 / R2）
   - 路徑一（後台）：Storage & Databases → D1 建 chippot-db；R2 建 chippot-proofs
   - 路徑二（CLI）：wrangler d1 create / wrangler r2 bucket create
   - 兩者皆把 D1 id 記下，稍後填進 wrangler.toml

## 3. 建立 Discord 應用與 Bot      ← 沿用現有（共用，兩路徑都要）
## 4. 設定 Cloudflare Access       ← 沿用現有（共用，兩路徑都要）

## 5. 填寫設定（wrangler.toml 佔位值）
   - 路徑一：在 GitHub fork 上用網頁編輯器改 packages/worker/wrangler.toml 的佔位值
             （routes/zone、DISCORD_APPLICATION_ID、DISCORD_PUBLIC_KEY、WEB_ORIGIN、
              ADMIN_ORIGIN、ACCESS_TEAM_DOMAIN、ACCESS_AUD、database_id），commit 到 fork
   - 路徑二：本機改同一檔；owner 用 `git update-index --skip-worktree packages/worker/wrangler.toml`
             讓真值不進 commit
   - 對照表（沿用 spec §4A 表格）

## 6. 部署
### 路徑一（主推）：Cloudflare 後台 + Git，零本機工具
   1. Fork repo 到自己的 GitHub
   2. Worker（Workers Builds）：後台 Workers & Pages → Create → 連到 fork；
      deploy command = `pnpm --filter @chippot/worker deploy`（會自動套 migration 再部署）
   3. 設 Worker runtime secret：Worker → Settings → Variables and Secrets → 加 DISCORD_BOT_TOKEN
   4. 部署後記下 worker 網址（chippot.<子網域>.workers.dev）
   5. web（Pages）：Create → Pages → 連 fork；
      build command = `pnpm --filter @chippot/web build`，output = packages/web/dist；
      build 變數 VITE_API_BASE = 第 4 步的 worker 網址
   6. admin（Pages）：build command = `pnpm --filter @chippot/admin build`，output = packages/admin/dist
   7. 綁自訂網域：web→pay.<域>、admin→admin.<域>；admin 需同時存在 Pages 自訂網域
      與 worker route admin.<域>/api/*（worker 對 /api/* 優先）
   8. 之後同步 fork（GitHub「Sync fork」）即自動重部署
### 路徑二（保留）：純 CLI wrangler
   1. git clone、pnpm install
   2. cd packages/worker && wrangler d1 migrations apply chippot-db --remote（或直接 pnpm deploy）
   3. wrangler secret put DISCORD_BOT_TOKEN
   4. pnpm --filter @chippot/worker deploy
   5. web：VITE_API_BASE=<worker 網址> pnpm --filter @chippot/web build && wrangler pages deploy ...
   6. admin：pnpm --filter @chippot/admin build && wrangler pages deploy ...

## 7. 註冊 Discord Slash 指令
   - 路徑一：登入後台 → 設定頁 → 按「註冊 / 更新 Discord slash 指令」
   - 路徑二：cd packages/worker && DISCORD_GUILD_ID=<id> pnpm --filter @chippot/worker register
   - 兩者皆對同一 PUT 端點操作（idempotent）

## 8. 首次設定（登入後台）        ← 沿用現有
## 9. 變數 / Secret 分層（速查表） ← 新增，用 spec §4D-4 表格
## 10. 常見問題                   ← 沿用現有 + 補：VITE_API_BASE 未設→繳費頁白屏/報錯；
                                    slash 指令沒出現→按設定頁按鈕或檢查 guild id；
                                    破壞性 migration 建議低流量時段先手動套
## 11. 之後更新版本               ← 路徑一：Sync fork 自動部署；路徑二：git pull + pnpm deploy + pages build
```

落筆原則：所有 owner 範例網域一律用 `example.com`；指令一律用 `pnpm --filter @chippot/<pkg>`；
migration 說明強調「deploy script 已自動套、idempotent、破壞性 migration 要謹慎」。

- [ ] **Step 2: 確認 DEPLOY.md 內無 owner 正式值**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
grep -n "panspace\|poterpan5466\|chippot.poterpan.workers.dev" docs/DEPLOY.md || echo "(乾淨，無 owner 正式值)"
```
Expected: `(乾淨，無 owner 正式值)`。

- [ ] **Step 3: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add docs/DEPLOY.md
git commit -m "docs(deploy): rewrite DEPLOY.md as dual-path (dashboard+Git / CLI)

Primary path: fork + edit wrangler.toml placeholders in the GitHub web editor +
connect Workers Builds & two Pages projects + set secrets in the dashboard — no
local toolchain. Secondary path: the existing wrangler CLI flow, preserved. Adds a
secret/var layering table, migration-in-deploy notes, and the same-origin route ordering."
```

---

## Task 7: genericize README owner 網域引用（計畫補強）

> 由 Task 1 程式品質審查發現：根目錄 README 也以 `admin.panspace.dev` 當架構範例，屬 spec §1 目標「清掉所有 owner 正式值」範圍。`docs/setup-checklist.md`（owner 內部一次性建置檔）的處置另行請 owner 定奪（刪除/gitignore），不在本任務。

**Files:**
- Modify: `README.md`（行 107、108、174 的 `admin.panspace.dev` / `admin.panspace.dev/api`）
- Modify: `README.zh-TW.md`（行 100、101、164 同上）

- [ ] **Step 1: 取代 owner 網域為範例網域**

把 `README.md` 與 `README.zh-TW.md` 中所有 `admin.panspace.dev` → `admin.example.com`（含 `/api/*` 與括號內路由說明），語意不變、只換網域。用 Grep 找出各行後逐一 Edit（或 `replace_all` 該字串）。

- [ ] **Step 2: 確認兩個 README 已無 owner 值**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
grep -n "panspace\|poterpan5466\|chippot.poterpan.workers.dev" README.md README.zh-TW.md || echo "(README 乾淨)"
```
Expected: `(README 乾淨)`。

- [ ] **Step 3: Commit**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git add README.md README.zh-TW.md
git commit -m "docs(readme): genericize owner domain in architecture examples

Replace admin.panspace.dev with admin.example.com in the README architecture
sections so the public repo carries no owner production domain."
```

## Final verification（全部 Task 完成後）

- [ ] **Step 1: 全 monorepo 綠燈（無 .dev.vars = CI 條件）**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
mv packages/worker/.dev.vars packages/worker/.dev.vars.off 2>/dev/null; true
pnpm -r typecheck && pnpm -r test 2>&1 | grep -E "Test Files|Tests " && VITE_API_BASE=https://example.workers.dev pnpm -r build 2>&1 | tail -3
mv packages/worker/.dev.vars.off packages/worker/.dev.vars 2>/dev/null; true
```
Expected: typecheck 全過；`Tests  160 passed (160)`；web/admin build 成功。

> 注意：`pnpm -r build` 時 web 需要 `VITE_API_BASE`，故上面帶入。實務 CI（GitHub Actions `ci.yml`）的 `pnpm -r build` 若未帶 VITE_API_BASE，web build 會在載入期才報錯而非 build 期失敗（見 Task 3 設計）——若希望 CI 也涵蓋，於後續評估是否在 web build 加 build 期檢查（本計畫不含，YAGNI）。

- [ ] **Step 2: 全 repo owner 值掃描**

Run:
```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
# 排除 docs/superpowers（設計/計畫文件本身合理地引用 panspace 來描述 before/after）
# 與 docs/setup-checklist.md（owner 內部檔，處置另議）。
grep -rn "panspace\|poterpan5466\|chippot.poterpan.workers.dev" README.md README.zh-TW.md packages docs \
  --include="*.ts" --include="*.tsx" --include="*.toml" --include="*.md" \
  | grep -v "docs/superpowers/" | grep -v "docs/setup-checklist.md" \
  || echo "(全乾淨)"
```
Expected: `(全乾淨)`。

---

## Self-Review 對照（spec → task）

- spec §4A（wrangler.toml 佔位值、移除 ACCESS_ALLOWED_EMAILS） → Task 1 ✓
- spec §4B（api.ts fail-loud、Payments.tsx 用後端 url） → Task 3、Task 2 ✓
- spec §4C（register-commands 路由 + 後台按鈕、import commands.ts payload、guild id 取自 settings） → Task 4 ✓
- spec §4D-2（migration 併進 deploy script） → Task 5 ✓
- spec §4D-1/D-3/D-4/D-5（Git 整合、VITE_API_BASE 順序、secret 分層、同源 route） → Task 6（DEPLOY.md）✓
- spec §4E（DEPLOY.md 雙路徑重寫） → Task 6 ✓
- spec §5（檔案異動清單） → 全 Task 覆蓋 ✓
- spec §6（測試：register-commands、upload-link url、api.ts 行為） → Task 2/3/4 測試 ✓
- spec §7（D1 token 實機驗證） → Task 5 Step 2 註記 + 部署階段確認 ✓

> 註：spec §7 的 Workers Builds D1 token 權限屬「部署實機驗證」，非程式碼可斷言，故列為部署階段確認項而非自動化測試。
