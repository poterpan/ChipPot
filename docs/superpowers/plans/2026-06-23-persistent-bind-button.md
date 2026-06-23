# 常駐公開綁定按鈕 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** 在 Discord 頻道常駐一則附「綁定」按鈕的公開訊息，讓成員主動自綁；保留付款時綁定為 fallback。

**Architecture:** 完全鏡像既有常駐繳費訊息（`discordPaymentMessage`）+ 既有綁定流程（`handleBindCommand`）。按鈕路由複用 `handleBindCommand`。

**Tech Stack:** Cloudflare Workers + D1, React admin SPA. Vitest pool-workers.

## Global Constraints
- `BIND_BUTTON_PREFIX` 必須是 `chippot:bindbtn`（不可 `chippot:bind`，會撞 `BIND_SELECT_PREFIX`）；dispatch 中先於 `BIND_SELECT_PREFIX` 檢查。
- 路由測試在 seeded workspace 1，ctx `{ identity: IDENT }`（wsId() 恆為 1）。
- 每 task 結束 commit。zh-TW 溝通。完成後一次 Codex review。

## File Structure
| 檔案 | 動作 |
|---|---|
| `packages/worker/src/adapters/discord/commands.ts` | `BIND_BUTTON_PREFIX` + `bindButtonRow` |
| `packages/worker/src/adapters/discord/handler.ts` | dispatch 路由 bind 按鈕 → `handleBindCommand` |
| `packages/worker/src/env.ts` | settings 加 `discord_bind_message_id` |
| `packages/worker/src/routes/admin.ts` | `discordBindMessage` handler + 路由 |
| `packages/admin/src/api.ts` | `rebuildBindMessage` |
| `packages/admin/src/views/Settings.tsx` | 「張貼/更新綁定按鈕訊息」按鈕 |
| `packages/worker/test/adapters/discord-bind-button.test.ts` | 建：按鈕互動 |
| `packages/worker/test/routes/admin.test.ts` | append：bind-message 路由 |

---

### Task 1: 綁定按鈕 + 路由

**Files:** commands.ts, handler.ts, test/adapters/discord-bind-button.test.ts

- [ ] **Step 1: 失敗測試**

```ts
// packages/worker/test/adapters/discord-bind-button.test.ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { routeInteraction, type DiscordInteraction } from "../../src/adapters/discord/handler";
import { BIND_BUTTON_PREFIX, bindButtonRow } from "../../src/adapters/discord/commands";

const TS = "2026-05-01T00:00:00.000Z";
const WS = 9400, GUILD = "guild-9400";
const CTX = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,owner_id,channel_type,billing_day,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(WS,"W","o","discord",5,JSON.stringify({ discord_guild_id: GUILD }),TS,TS),
    // one unbound member so the picker has an option
    env.DB.prepare(`INSERT INTO users (id,workspace_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(WS,WS,"阿明",TS,TS),
  ]);
});

describe("persistent bind button", () => {
  it("bindButtonRow uses the bindbtn prefix (must not collide with bind-select)", () => {
    const row = bindButtonRow(WS) as any;
    expect(row.components[0].custom_id).toBe(`${BIND_BUTTON_PREFIX}:${WS}`);
    expect(BIND_BUTTON_PREFIX).toBe("chippot:bindbtn");
  });
  it("clicking the bind button returns an ephemeral name picker for an unbound member", async () => {
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "disc-new" } },
      data: { custom_id: `${BIND_BUTTON_PREFIX}:${WS}`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    const body = await res.json() as any;
    expect(body.type).toBe(4); // RT_MESSAGE
    expect(JSON.stringify(body)).toContain("chippot:bind:"); // the select row, not mis-routed
    expect(JSON.stringify(body)).toContain("阿明");
  });
  it("an already-bound user gets the 已綁定 notice", async () => {
    await env.DB.prepare(`INSERT INTO users (id,workspace_id,discord_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(94001,WS,"disc-bound","小華",TS,TS).run();
    const i: DiscordInteraction = {
      type: 3, id: "1", token: "t", guild_id: GUILD, member: { user: { id: "disc-bound" } },
      data: { custom_id: `${BIND_BUTTON_PREFIX}:${WS}`, component_type: 2 },
    };
    const res = await routeInteraction(i, env, CTX);
    expect((await res.json() as any).data.content).toContain("已綁定");
  });
});
```

- [ ] **Step 2: 跑→失敗**

`pnpm --filter @chippot/worker exec vitest run test/adapters/discord-bind-button.test.ts` → FAIL（`BIND_BUTTON_PREFIX`/`bindButtonRow` 不存在）。

- [ ] **Step 3: 實作 commands.ts**

```ts
// 在 BIND_SELECT_PREFIX 附近加：
export const BIND_BUTTON_PREFIX = "chippot:bindbtn"; // 注意：不可與 BIND_SELECT_PREFIX("chippot:bind") 撞

// 在 payButtonRow 附近加：
/** Persistent public "綁定 Discord" button row. custom_id = action:workspace. */
export function bindButtonRow(workspaceId = 1) {
  return {
    type: CT_ACTION_ROW,
    components: [{ type: CT_BUTTON, style: 2, label: "綁定 Discord", custom_id: `${BIND_BUTTON_PREFIX}:${workspaceId}` }],
  };
}
```

- [ ] **Step 4: 實作 handler.ts dispatch**

import 補 `BIND_BUTTON_PREFIX`（從 commands）。在 `handleComponent` 內、`BIND_SELECT_PREFIX` 檢查**之前**加：

```ts
  if (cid.startsWith(BIND_BUTTON_PREFIX)) return handleBindCommand(i, env); // 先於 BIND_SELECT（prefix 重疊）
```

- [ ] **Step 5: 跑→通過**

`pnpm --filter @chippot/worker exec vitest run test/adapters/discord-bind-button.test.ts` → PASS（3）。

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/adapters/discord/commands.ts packages/worker/src/adapters/discord/handler.ts packages/worker/test/adapters/discord-bind-button.test.ts
git commit -m "feat(discord): persistent public bind button (reuses bind picker flow)"
```

---

### Task 2: 設定欄位 + 張貼/更新訊息端點

**Files:** env.ts, routes/admin.ts, test/routes/admin.test.ts

- [ ] **Step 1: 失敗測試（append 到 admin.test.ts）**

```ts
describe("POST /admin/discord/bind-message", () => {
  it("400 without a billing channel configured", async () => {
    // seeded ws1 has no discord_billing_channel_id by default
    const res = await call("POST", "/admin/discord/bind-message");
    expect(res!.status).toBe(400);
  });
  it("posts a bind-button message and stores discord_bind_message_id", async () => {
    (env as any).DISCORD_BOT_TOKEN = "test-bot-token";
    await env.DB.prepare("UPDATE workspaces SET settings = json_set(settings, '$.discord_billing_channel_id', ?) WHERE id = 1").bind("chan-1").run();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg-bind-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("POST", "/admin/discord/bind-message");
    vi.unstubAllGlobals();
    delete (env as any).DISCORD_BOT_TOKEN;
    expect(res!.status).toBe(200);
    const r = await res!.json() as any;
    expect(r.message_id).toBe("msg-bind-1");
    const s = await env.DB.prepare("SELECT json_extract(settings,'$.discord_bind_message_id') AS m FROM workspaces WHERE id=1").first<{m:string}>();
    expect(s?.m).toBe("msg-bind-1");
  });
});
```

> 註：`admin.test.ts` 既有 `call()`、`vi` import。若無 `vi` 請於檔頭 `import { ..., vi } from "vitest"`。

- [ ] **Step 2: 跑→失敗**

`pnpm --filter @chippot/worker exec vitest run test/routes/admin.test.ts -t bind-message` → FAIL（404）。

- [ ] **Step 3: env.ts settings**

`WorkspaceSettings` 介面加 `discord_bind_message_id: string;`；`DEFAULT_SETTINGS` 加 `discord_bind_message_id: "",`；`parseSettings` 加 `discord_bind_message_id: str(raw.discord_bind_message_id, ""),`（緊接 `discord_payment_message_id` 後）。

- [ ] **Step 4: admin.ts handler + 路由**

import 補 `bindButtonRow`（從 commands；與 `payButtonRow` 同行）。加 handler（放在 `discordPaymentMessage` 後）：

```ts
async function discordBindMessage(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const ws = wsId(ctx);
  const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
  if (!row) return errorResponse(404, "not found");
  const settings = parseSettings(row.settings);
  const channelId = settings.discord_billing_channel_id;
  if (!channelId) return errorResponse(400, "discord_billing_channel_id is not set");
  if (!env.DISCORD_BOT_TOKEN) return errorResponse(400, "bot token not configured");

  const body = {
    content: "👋 還沒綁定的成員，點下方按鈕綁定你的 Discord 帳號；綁定後開繳／催繳才能 @ 到你。",
    components: [bindButtonRow(ws)],
  };
  let messageId = settings.discord_bind_message_id;
  let ok = false;
  if (messageId) ok = await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, body);
  if (!ok) {
    messageId = (await createChannelMessage(env.DISCORD_BOT_TOKEN, channelId, body)) ?? "";
    ok = !!messageId;
  }
  if (!ok) return errorResponse(502, "failed to post Discord message");

  await env.DB.prepare("UPDATE workspaces SET settings = json_set(settings, '$.discord_bind_message_id', ?), updated_at = ? WHERE id = ?")
    .bind(messageId, nowUtcIso(), ws).run();
  await writeAudit(env.DB, { workspaceId: ws, actor: actorOf(ctx), action: "discord.bind_message", entityType: "workspace", entityId: ws, after: { message_id: messageId } });
  return json({ ok: true, message_id: messageId });
}
```

註冊（在 `.post("/admin/discord/payment-message", discordPaymentMessage)` 後）：

```ts
    .post("/admin/discord/bind-message", discordBindMessage)
```

- [ ] **Step 5: 跑→通過**

`pnpm --filter @chippot/worker exec vitest run test/routes/admin.test.ts -t bind-message` → PASS（2）。

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/env.ts packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(admin): POST /admin/discord/bind-message (post/refresh persistent bind button)"
```

---

### Task 3: 後台 UI

**Files:** admin/src/api.ts, admin/src/views/Settings.tsx

- [ ] **Step 1: api.ts**

在 `rebuildPaymentMessage` 旁加：

```ts
  rebuildBindMessage: () => req<{ message_id: string }>("POST", "/discord/bind-message"),
```

- [ ] **Step 2: Settings.tsx 按鈕**

找到既有呼叫 `api.rebuildPaymentMessage` 的按鈕（`ActionRow`/`TestButton` 區），在其旁加一顆同型按鈕呼叫 `api.rebuildBindMessage()`，文案「張貼／更新綁定按鈕訊息」，desc「在帳單頻道貼一則含『綁定 Discord』按鈕的公開訊息，讓成員主動綁定。」沿用該區既有的 busy/result 呈現模式（照抄繳費訊息那顆的寫法，只換 api 方法與文案）。

- [ ] **Step 3: 型別檢查**

`pnpm --filter @chippot/admin exec tsc --noEmit` → 0。

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/views/Settings.tsx
git commit -m "feat(admin-ui): button to post/refresh the persistent bind-button message"
```

---

## 收尾
- [ ] 全 worker 測試綠 + admin tsc/build。
- [ ] Codex review（按鈕路由 prefix 順序、端點鏡像正確性）；處理意見。
- [ ] PR → CI → merge → 手動部署（worker + admin Pages）→ 記 deploy-state.md。
- [ ] 更新 memory `chippo-bind-button-queued`（標記已完成/上線）。

## Self-Review
- Spec §3A-E 對應 Task 1（A、B）/Task 2（C、D）/Task 3（E）。測試 §5 → Task1 handler 測試 + Task2 路由測試。✓
- prefix 順序：bind 按鈕 dispatch 在 `BIND_SELECT_PREFIX` 前（Task1 Step4），測試驗證未誤攔（Task1 Step1 第二測試斷言含 `chippot:bind:` 選單）。✓
- 型別/命名：`BIND_BUTTON_PREFIX`、`bindButtonRow`、`discord_bind_message_id`、`rebuildBindMessage` 跨 task 一致。✓
