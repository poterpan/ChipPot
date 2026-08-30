# UX-D 術語與文案統一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every zh-TW string in ChipPot use one word per concept — 驗證 (not 核准), 已繳待驗 (not 已繳), 繳費渠道 (not 支付渠道), 此期 (not 本期), 開繳 (not 開帳), 成員 (not 使用者) — and stop showing raw English enums and raw English worker errors to Chinese-reading users.

**Architecture:** This is a copy sweep, not a refactor. §A below is the canonical-terms SPEC — one mapping table per concept. Each task takes one concept, **regenerates its own edit-site list with `git grep` at execution time**, applies the mapping, then proves the concept is gone with a zero-hits assertion. Nothing in this plan changes a DB value, an API request/response *shape*, an enum stored in D1, or a `custom_id`. Three tasks do change API response *strings* (`routes/admin.ts` errors, `core/payments.ts` race message) and Discord reply strings; those are TDD with real vitest assertions.

**Tech Stack:** TypeScript, React 18 (admin + web SPAs, Vite 6), Cloudflare Workers, Vitest 4 with `@cloudflare/vitest-pool-workers` (real Miniflare D1/R2), pnpm workspaces.

---

## Why this plan has no line numbers

This batch runs **last** — after UX-A (danger actions, `#43`), UX-B (mobile/a11y, `#44`) and UX-C (member feedback, `#45`) have merged. Those batches rewrite `Dashboard.tsx`, `Payments.tsx`, `Manage.tsx`, `Settings.tsx`, `handler.ts` and `web/App.tsx`. **Every line number in the source audit (`.superpowers/sdd/ux-audit-copy.md`) is stale by the time you read this.**

So: the audit's `file:line` lists are an *inventory of what existed on 2026-07-30*, reproduced in §A only to tell you roughly how many sites to expect. **Never navigate by line number.** Every task starts with a `git grep` that rebuilds the list from the tree you actually have, and ends with the same grep returning nothing.

Three consequences you must internalise:

1. **A site may already be fixed.** UX-A owns `A5` (the 發起繳費 「本期」 wording). If your grep shows it already reads `${period}`, that is success, not a missing file — move on.
2. **A site may have moved to a file this plan never names.** If `git grep` finds the term in a file not listed in §B, fix it there too. The grep is the authority; §B is a hint.
3. **A string may have been reworded.** Match on the *concept*, not on the exact old sentence. If UX-A rewrote a tooltip and it still says 「本期」, the 本期 sweep still owns that word.

`docs/superpowers/plans/**` is a **historical archive**. It contains 核准, 已繳, 本期 in abundance. **Never edit it.** Every grep in this plan is pathspec-scoped to `packages README.md README.zh-TW.md` precisely to keep it out.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch:** `ux/46-terminology`, cut from `main` after A/B/C have merged. One PR, body contains `Closes #46`.
- **Worker suite green after every task.** Baseline on 2026-07-31 (before A/B/C) was **300 passed, 41 files**. A/B/C will raise it. **Do not hardcode 300 anywhere** — capture the real baseline in Task 1 Step 2 and use that number.
- **`pnpm -r typecheck` green after every task** (worker + admin + web `tsc --noEmit`).
- **Admin and web must build:** `pnpm --filter @chippot/admin build` and `VITE_API_BASE=https://example.invalid pnpm --filter @chippot/web build`. Run both in Task 15; run them earlier too if a task touched `.tsx` and you want the signal.
- **`packages/worker/wrangler.toml` must not be touched.** It is `skip-worktree`'d locally and its committed copy holds placeholders. Do not `git add` it, do not open it to "check" something.
- **`docs/deploy-state.md` is gitignored (`.gitignore:10`) — local-only.** Append the entry (Task 15) but **never `git add` it**; `git add docs/` would fail to stage it anyway, so use explicit paths in every `git add`.
- **Conventional commits**, zh-TW subject line after the type/scope, matching repo history (e.g. `fix(admin-ui): 彈窗內文字不再繼承靠右對齊 (#33)`).
- **Display-layer only.** English enum *values* (`active`/`paused`/`cancelled`, `user_slash`/`admin_manual`/`cron`, `pending`/`paid`/`verified`/`rejected`) stay English in the DB, in `<option value=…>`, in request bodies and in every SQL string. Only what a human reads changes.
- **Do not edit `docs/superpowers/plans/**`** (historical record) or `.superpowers/sdd/**` (audit record).
- **Both READMEs are in scope of every sweep.** `README.md` (English prose, but it quotes zh-TW UI labels verbatim) and `README.zh-TW.md`. A sweep that leaves a README naming a button that no longer exists is a failed sweep.
- **One commit per task**, and the worker suite must be green *at that commit*.

---

# §A — Canonical terms SPEC

This is the contract. Where a task and this table disagree, this table wins.

### A.1 驗證 (D1 / copy P1-1) — the act of accepting a payment

Four words for one action today. **驗證** is the verb, **已驗證** is the resulting state, **審核** is the process/queue name (keep — it is the nav label 繳費審核 and the 已繳待驗 queue). **核准 is deleted entirely, including from code comments and test titles.**

| Old (audit found ~17 sites incl. comments) | New |
|---|---|
| `核准` (button label) | `驗證` |
| `一鍵全部核准` | `一鍵全部驗證` |
| `核准已繳待驗（N 筆）` | `驗證已繳待驗（N 筆）` |
| `已核准 ${n} 筆` | `已驗證 ${n} 筆` |
| `已核准 ${n} 筆，另 ${m} 筆（待繳／已退回）需逐筆處理` | `已驗證 ${n} 筆，另 ${m} 筆（待繳／已退回）需逐筆處理` |
| `批次核准中斷，已核准 ${n} 筆：${message}` | `批次驗證中斷，已驗證 ${n} 筆：${message}` |
| `標記已驗證` (button label, PaymentDetail) | `驗證` |
| `標記已驗證（帶入申報渠道）` (tooltip) | `標記為「已驗證」（帶入申報渠道）` |
| `一鍵全部核准` inside English code comments / `describe()` titles | `一鍵全部驗證` |
| README `一鍵全部核准` / `單筆核准／退回` / `一鍵掃過去核准` | `一鍵全部驗證` / `單筆驗證／退回` / `一鍵掃過去驗證` |

**Keep unchanged:** `撤回驗證` (PaymentDetail), `繳費審核` (nav label), `審核` in prose meaning the process, `已驗證` everywhere.

### A.2 `paid` 狀態 (D2 / copy P1-2)

`已繳` reads as "the money arrived", but the state means "member says they paid, nobody checked yet". **已繳待驗** everywhere, **待驗** where a table header has no room.

| Old | New | Note |
|---|---|---|
| `STATUS_LABEL.paid = "已繳"` (`ui.tsx`) | `"已繳待驗"` | the badge — the single highest-value fix here |
| Dashboard 各方案 table header `已繳` | `待驗` | 7-column table, no room for 3 more chars |
| `🔒 保留(已繳)` (Stat label, ×2: SyncModal + RetractModal) | `🔒 保留（已繳待驗、已驗證）` | frozen = `paid` **+** `verified` (see `billing.ts` frozen calc and the modal's own prose) — the old label was also *wrong*, not just inconsistent. Parens go full-width (§A.10). |
| `保留 ${n} 筆已繳。` (retract success line) | `保留 ${n} 筆已繳待驗／已驗證。` | prose "A or B" → ／ (§A.10) |
| `已繳／已驗證的紀錄不受影響` / `已繳／已驗證的 ${n} 筆一律原樣保留` | **unchanged** | already the accurate pair |
| README `已繳待驗` | unchanged; README `已繳／已驗證` unchanged |

**Do not** rename `已繳待驗` → anything. It is already canonical in `Payments.tsx` pills, `Dashboard.tsx` stats and `MemberReview.tsx`.

### A.3 期別標籤 (D3 + D5 + D7 / copy P1-3, P1-5, P1-7) — inherited from the deferred batch E

**本期 is deleted.** Three replacements depending on what the sentence actually means:

| Situation | Replacement |
|---|---|
| A control acting on the admin's currently-picked period, and the period value is in scope | interpolate the real value — `${period}` |
| A control acting on the picked period, value **not** in scope (button labels, tooltips, ActionRow descriptions) | `此期` / `所選期別` |
| Discord replies to a member, period value in scope | interpolate `${period}` and drop the 本期 framing (never say 期別 to a member — §A.4) |

Concrete mapping (regenerate the site list; these are the strings as of the audit):

| Old | New |
|---|---|
| `重新同步本期` (button) | `重新同步此期帳單` — **full name**, so `Settings.tsx`'s reference matches the button exactly (D7) |
| `對齊本期帳單到目前名單／現價` (tooltip) | `對齊此期帳單到目前名單／現價` |
| `收回本期開繳` (button) | `收回此期開繳` |
| `重新同步本期帳單 · ${period}` (modal title) | `重新同步此期帳單 · ${period}` |
| `收回本期開繳 · ${period}` (modal title) | `收回此期開繳 · ${period}` |
| `本期已是最新，無需變更。` | `此期已是最新，無需變更。` |
| `本期沒有可刪除的未繳／已退回帳單，收回只會把期別改回「未開繳」。` | `此期沒有可刪除的未繳／已退回帳單，收回只會把期別改回「未開繳」。` |
| `收回後本期回到「未開繳」：刪掉的帳單不會被「重新同步本期」補回來…` | `收回後此期回到「未開繳」：刪掉的帳單不會被「重新同步此期帳單」補回來…` |
| `…重開本期也不會重複開帳單。` | `…重開此期也不會重複產生帳單。` (also kills 開帳 — §A.5) |
| `請到「繳費審核」按重新同步本期帳單清理` (Settings import warning) | `請到「繳費審核」按「重新同步此期帳單」清理` |
| `確認本期金額並向所有成員發出開繳通知。` (Settings ActionRow desc) | `確認所選期別的金額並向所有成員發出開繳通知。` |
| `（管理員）確認本期各方案金額並發出開繳通知` (`/發起繳費` description) | `（管理員）確認指定期別各方案金額並發出開繳通知` |
| `✅ 已更新本期金額（…）。本期通知先前已發送，未重複發送。` | `✅ 已更新 ${period} 金額（…）。${period} 的通知先前已發送，未重複發送。` |
| `本期（${current}）繳費尚未開放，待管理員發出開繳通知後即可繳費。` (×2, Discord) | `${current} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。` |
| `本期（${period}）已登記繳費，無需重複操作。` | `${period} 已登記繳費，無需重複操作。` |
| `✅ 已登記本期（${period}）繳費 NT$…` | `✅ 已登記 ${period} 繳費 NT$…` |
| `本期繳費尚未開放，待管理員發出開繳通知後即可繳費。` (pay-select guard) | `${period} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。` (`period` is in scope there) |
| `✅ 你本期已登記繳費，無需重複操作。` | `✅ ${period} 已登記繳費，無需重複操作。` |
| README `重新同步本期帳單` (both files) | `重新同步此期帳單` |
| README `確認本期各方案金額` | `確認指定期別各方案金額` |
| `本期尚無資料` / `本期尚無已驗證款項` (Dashboard empty states) | `此期尚無資料` / `此期尚無已驗證款項` |

**Some of these belong to UX-A (A5).** If A already interpolated the period, skip. If A left it, fix it here — D is last and owns the leftover.

### A.4 期別 (後台) vs 月份 (成員面) (D4 / copy P1-4)

Same `YYYY-MM` value, two audiences, one word each.

| Surface | Word |
|---|---|
| Admin SPA (`packages/admin`) | **期別** |
| Discord bot replies (`adapters/discord/**`), member pay page (`packages/web`) | **月份** |

| Old | New |
|---|---|
| `<span className="stub__label">期別</span>` (web pay page) | `月份` |
| Discord `選擇要繳的月份` / `你有多個月份待繳` / `這個月份已無待繳項目` / `✅ 這個月份已登記繳費` | **unchanged** (already correct) |

**Documented exception — leave alone:** `Settings.tsx` CSV import `起算月份第一天（選填，YYYY-MM-DD）` and the prose `起算月份留空＝當月`. That field is a **date** (`start_date`, `YYYY-MM-DD`), not a period selector; calling it 期別 would be a lie. This is the *only* permitted 月份 in `packages/admin` and the leftover assertion in Task 5 allows exactly these.

### A.5 開繳 (D5 / copy P1-5)

**開帳 is deleted** (3 sites). The action is 發起繳費 / 開繳, the notification is 開繳通知, the data row is 帳單.

| Old | New |
|---|---|
| `每月幾號向所有成員開帳收費（1–28）。` | `每月幾號自動向所有成員開繳（1-28）。` (also fixes the en-dash — §A.10) |
| `開帳後幾天仍未繳就列入催繳。` | `開繳後幾天仍未繳就列入催繳。` |
| `重開本期也不會重複開帳單。` | `重開此期也不會重複產生帳單。` (same edit as §A.3) |
| README.zh-TW `自動開帳、每期發一則整批催繳` | `自動開繳、每期發一則整批催繳` |
| README.zh-TW architecture diagram `— 開帳 / 催繳 / 保存期` | `— 開繳 / 催繳 / 保存期` |
| `📢 **{period} 開始繳費**` (default `billing_opened_template` in `env.ts`) | `📢 **{period} 開繳**` |

**Note on the template default:** changing `DEFAULT_SETTINGS.billing_opened_template` only affects workspaces that have **never** customised it (`parseSettings` falls back to the default). Production may already hold a saved template, in which case nothing changes there. `env.test.ts` asserts the default's *shape* (`toEqual(DEFAULT_SETTINGS)`, `toContain("{plans}")`), not its prose, so this is test-safe — verify that claim by running the suite, don't assume it.

### A.6 繳費渠道 (D8 / copy P1-8) and 繳費頻道 (D6 / copy P1-6)

| Old | New |
|---|---|
| `支付渠道` (nav label, Card title, delete-confirm prose) | `繳費渠道` |
| `渠道` as a table header / short field name | **unchanged** — the sanctioned short form |
| `在帳單頻道貼一則含「綁定 Discord」按鈕的公開訊息` | `在繳費頻道貼一則含「綁定 Discord」按鈕的公開訊息` |

Both names point at the same `discord_billing_channel_id`; the field label is already `繳費頻道 ID`.

### A.7 成員 (D9 / copy P1-9)

| Old | New |
|---|---|
| `<dt>使用者備註</dt>` | `<dt>成員備註</dt>` (matches `MemberReview`'s `成員備註：`) |

`使用者` must reach **zero** occurrences in `packages/**`. `夥伴` stays — it is a member-facing greeting in `web` (`嗨，{name} 夥伴`) and in the default overdue template, and the audit explicitly permits it there.

### A.8 純聲明 (D10 / copy P1-10)

One state (`paid`/`verified` with `has_proof = 0`), one label.

| Old | New |
|---|---|
| `無憑證(已繳)` (Dashboard stat) | `純聲明（已繳待驗、已驗證）` — matches the SQL, which is `status IN ('paid','verified') AND has_proof = 0` |
| `純聲明` (Payments table cell) | unchanged |
| `無憑證，純聲明 — 請依備註與帳戶自行核對。` (×2) | unchanged — this is the one place 無憑證 is allowed, as explanatory prose |

### A.9 enum → zh-TW 顯示對映 (D11 / copy P1-11) — **display layer only**

Follow the existing precedent in `Manage.tsx`: `CHANNEL_TYPES` + `CHANNEL_TYPE_LABEL` (a `Record<string,string>` with `?? raw` fallback). Never change a stored value.

**`payments.source`** (schema: `CHECK (source IN ('user','user_slash','user_web','admin_manual','cron'))`):

| value | who writes it | label |
|---|---|---|
| `user` | nobody today — schema default, so only legacy rows | `Discord（舊版）` |
| `user_slash` | `/繳費` **and** the 繳費 button channel-select | `Discord` |
| `user_web` | `routes/upload.ts` | `網頁上傳` |
| `admin_manual` | `routes/admin.ts` manual entry | `後台補登` |
| `cron` | `billing.ts` bill creation default (cron **and** 發起繳費/同步, which pass no source) | `系統建立` |

**`subscriptions.status`** (`active`/`paused`/`cancelled`): `啟用中` / `暫停` / `已取消`.

**`plans.provider`** — a free-text column, not an enum. Only its *label* is English:

| Old | New |
|---|---|
| `<th>provider</th>` | `<th>供應商</th>` |
| `provider（選現有或直接輸入新的，如 gemini、glm）` | `供應商（選現有或直接輸入新的，如 gemini、glm）` |
| `請填 provider` (client-side validation) | `請填供應商` |

And the sentence that teaches admins the raw enum:

| Old | New |
|---|---|
| `（若只想停收可改用「編輯 → 狀態 cancelled」）` | `（若只想停收，可改用「編輯 → 狀態：已取消」）` |

### A.10 標點與格式 (D17 + D18 / copy P2-1,2,3,4,6,10,11)

Rules, in force for every task in this plan — not just the format task:

1. **Parentheses.** Inside a Chinese sentence or a Chinese-content label → full-width `（）` with no surrounding space. A label whose parenthetical is a pure Latin/numeric token → half-width `()` with one leading space: `月費 (TWD)`, `起算日 (YYYY-MM-DD)`, `結帳日 (1-28)`, `${p.name} 金額 (NT$)` all stay as they are.
2. **Number ranges** use an ASCII hyphen: `1-28`. The one en-dash (`1–28`) becomes `1-28`.
3. **Enumerations** separate with `、`. **"A or B" prose** uses full-width `／`. Never a half-width `/` between Chinese words.
4. **Admin success messages** are prefixed `✓ ` (space after). Discord keeps `✅` — cross-surface difference is fine, intra-surface is not.
5. **A button that opens a dialog needing more input gets a trailing `…`** — but only toolbar/header actions. Row-level `編輯`／`刪除`／`停用`／`啟用` do **not** (adding `…` to every table row is noise, especially in UX-B's mobile cards).
6. **Progress text** in a preview modal is `計算差異中…` (both the sync and retract previews compute a diff).
7. **Member-facing sentences end with `。`**

### A.11 千分位 (D19 / copy P2-5)

Any rendered TWD amount uses `.toLocaleString()`, matching `ui.tsx`'s `Money`, `core/notify.ts` and the Discord handler. Four known holes: the web pay page's per-subscription amount and total, and the admin plan `<select>` option and plan-table monthly fee. **Call it exactly as the codebase already does — `v.toLocaleString()` with no locale argument** — do not introduce `Intl.NumberFormat` or a locale string.

### A.12 至少填一項 (D13 + P0-8 / copy P1-15, P0-5)

One sentence, one field order (渠道 → 截圖 → 備註, matching the UI):

> `渠道、截圖、備註至少填一項。`

and when screenshots are disabled (no R2):

> `渠道、備註至少填一項。`

The Discord command description is the **exception**, taken verbatim from issue #46 because Discord descriptions are a different register and length-capped:

> `登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註 至少填一項）`

### A.13 語氣 (D20 / copy P2-7, P2-9, P2-12)

| Old | New |
|---|---|
| `解除後他可重新用綁定按鈕／指令綁定。` | `解除後可重新用綁定按鈕／指令綁定。` |
| `（開繳／催繳才能 @ 到他）` | `（開繳／催繳才 @ 得到）` |
| `<title>ChipPot · 繳費上傳</title>` | `<title>ChipPot · 繳費登記</title>` — screenshots are optional and may be disabled entirely |
| `連線失敗，請稍後再試` | `連線失敗，請稍後再試。` |

Never reintroduce a gendered third-person pronoun for a member. zh-TW drops the pronoun.

### A.14 錯誤訊息中文化 (D14 + D15 / copy P1-16, P1-17)

**In scope** — the settings-tools group and `not found`, i.e. everything an admin can actually reach by clicking:

| English (match by handler, not line) | zh-TW |
|---|---|
| `not found` (every 404 in `routes/admin.ts`) | per-entity: `找不到這位成員` / `找不到這筆訂閱` / `找不到這個方案` / `找不到這個渠道` / `找不到這筆繳費紀錄` / `找不到工作區設定` |
| `discord_billing_channel_id is not set` | `尚未設定繳費頻道 ID，請到「設定 → Discord 串接」填入。` |
| `discord_guild_id is not set` | `尚未設定伺服器 ID（Guild），請到「設定 → Discord 串接」填入。` |
| `bot token not configured` | `尚未設定 Discord Bot Token，請在 Worker 環境變數設定後重新部署。` |
| `DISCORD_APPLICATION_ID is not set` | `尚未設定 DISCORD_APPLICATION_ID，請在 Worker 環境變數設定後重新部署。` |
| `WEB_ORIGIN is not configured` | `尚未設定 WEB_ORIGIN，無法產生上傳連結；請在 Worker 環境變數設定後重新部署。` |
| `failed to post Discord message` | `Discord 訊息張貼失敗，請確認機器人在該頻道有發言權限。` |
| `failed to register commands` | `指令註冊失敗，請確認 Bot Token 與伺服器 ID 是否正確。` |
| `invalid channel tag` | `渠道無效，請重新選擇。` |
| `invalid user` | `找不到這位成員。` |
| `invalid subscription` | `找不到這筆訂閱。` |
| `invalid status` | `狀態無效。` |
| `integer amount required` | `金額必須是整數。` |
| `amount must be a non-negative integer` | `金額必須是 0 或正整數。` |
| `payment ${id} cannot transition to '${to}'` (`core/payments.ts`) | `這筆的狀態已被變動（可能已由其他人處理），請重新載入後再試。` |

**Deliberately left in English** (audit X4 — unreachable from the UI because the inputs are `type="month"` / `type="number"` / client-side-required): `period must be YYYY-MM`, `billing_day must be 1..28`, `start_date must be YYYY-MM-DD`, `amounts is required`, `each amount needs an integer plan_id and non-negative amount`, `type must be billing_opened or overdue`, `kind must be bark or webhook`, `expected a multipart form`, `csv is required`, `display_name is required`, `name is required`, `name, provider, monthly_amount are required`, `user_id, plan_id, start_date are required`, `subscription_id and period are required`, `user_id and period are required`, `user_id must be a positive integer`, `` `${param} must be a positive integer` ``.

**Out of scope — belongs to UX-C (#45, its P0-6):** `routes/upload.ts` and `core/storage.ts` English errors reaching the member pay page. Do not touch them; if C somehow left them, file a follow-up rather than widening this PR.

**`InvalidPaymentTransition` must keep its `paymentId` and `to` public fields** — they are the debugging handle once the message stops naming the id.

### A.15 標註而非改造 (D16, D21, D22)

Three findings resolve as **annotation this round**, deliberately:

- **D16 (hardcoded vs templated messages).** Three messages are editable in 設定 → Discord 訊息文字 (開繳通知/逾期催繳/常駐繳費訊息); the bind-button message and the new-member nudge are hardcoded in the worker. Unifying them is a settings-schema change = batch E scope. **Annotate**: one line in the Settings card description saying which messages the card covers, plus a code comment at each hardcoded builder.
- **D21 (`plans.discord_role_id`).** It is used only to `@` a role in announcements; ChipPot never grants or revokes roles. The field label currently implies less than it should. **Fix the label** so nobody expects automation.
- **D22 (`settings.timezone`).** Parsed in `env.ts`, read by nobody; time is hardcoded `Asia/Taipei` in `core/time.ts`. There is **no admin UI field** for it (verified: `timezone` appears only in `env.ts`). Removing it would change the settings schema and the `parseSettings` round-trip that `env.test.ts` asserts — scope creep. **Annotate in code + README.**

---

# §B — File map

Where each concept lived on 2026-07-30. **A hint, not a target list** — `git grep` is the authority.

| File | Responsibility | Concepts it carried |
|---|---|---|
| `packages/admin/src/ui.tsx` | shared admin primitives (`StatusBadge`, `Money`, `Modal`, `Stat`) | A.2 (`STATUS_LABEL`) |
| `packages/admin/src/App.tsx` | nav shell + view registry | A.6 (nav label) |
| `packages/admin/src/views/Payments.tsx` | payments list, sync/retract/manual/link modals | A.2, A.3, A.8, A.10 |
| `packages/admin/src/views/MemberReview.tsx` | member × period aggregate review | A.1, A.2 |
| `packages/admin/src/views/PaymentDetail.tsx` | single-payment modal | A.1, A.7, A.9 (`source`) |
| `packages/admin/src/views/Dashboard.tsx` | reconcile board + push status | A.2, A.3, A.8, A.10 |
| `packages/admin/src/views/Manage.tsx` | 成員/訂閱/方案/渠道 CRUD | A.6, A.9, A.10, A.11, A.13 |
| `packages/admin/src/views/Settings.tsx` | settings + tools + CSV import | A.3, A.4, A.5, A.6, A.10, A.13, A.15 |
| `packages/web/src/App.tsx` | member pay page | A.4, A.11, A.12, A.13 |
| `packages/web/src/api.ts` | member pay page fetch layer | A.13 |
| `packages/web/index.html` | member page `<title>` | A.13 |
| `packages/worker/src/adapters/discord/commands.ts` | slash-command registration payloads + component builders | A.3, A.12 — **Discord-visible; see Task 15's re-register note** |
| `packages/worker/scripts/register-commands.mjs` | standalone `pnpm register` script | **hand-duplicates both command descriptions** (a `.mjs` can't import the TS module; its header says "Keep these payloads in sync"). Tasks 1 and 4 must edit both copies; Task 15 Step 2b proves they agree. |
| `packages/worker/src/adapters/discord/handler.ts` | all Discord interaction replies | A.3, A.12 |
| `packages/worker/src/env.ts` | settings schema + default templates | A.5, A.15 |
| `packages/worker/src/routes/admin.ts` | admin API + its error strings | A.1, A.14 |
| `packages/worker/src/core/payments.ts` | payment state machine | A.1 (comment), A.14 |
| `packages/worker/test/**` | vitest suite — asserts several of these strings | every task |
| `README.md`, `README.zh-TW.md` | user-facing docs quoting zh-TW labels | every task |

**Known test assertions that this plan breaks** (find them with the greps, don't trust this list to stay complete):
- `test/adapters/discord-pay.test.ts` — `expect(captured).toContain("已登記本期")` → breaks in Task 4.
- `test/core/payments-verify-all.test.ts` — `describe("verifyUserPeriod (一鍵全部核准)")` → renamed in Task 2.
- `test/routes/payments-review.test.ts` — asserts `toContain("模擬硬錯誤")`, the *inner* message. Task 2 changes only the outer 批次核准中斷 wrapper, so this assertion survives. Confirm by running, don't assume.

---

# §C — Tasks

## Task 1: 分支、基準線，與兩個 P0 誤導文案

Two P0s: a diff heading that calls a *paused* subscription 退訂, and a `/繳費` description that says three fields are optional when at least one is mandatory.

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx` (the `DiffList title="移除（已退訂）"` in the sync preview)
- Modify: `packages/worker/src/adapters/discord/commands.ts` (`PAY_COMMAND.description`)
- Modify: `packages/worker/scripts/register-commands.mjs` — **the same description is duplicated here** (the `.mjs` cannot import the TS module without a build step; its header comment says "Keep these payloads in sync"). Miss it and `pnpm --filter @chippot/worker register` silently re-registers the old wording.
- Test: `packages/worker/test/` — run the whole suite; no new test (a registration-payload literal has no behaviour to assert beyond what `commands.ts` already is)

**Interfaces:**
- Consumes: nothing.
- Produces: branch `ux/46-terminology`; the recorded baseline test count that Tasks 2–15 compare against.

- [ ] **Step 1: Cut the branch**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git checkout main && git pull
git checkout -b ux/46-terminology
```

- [ ] **Step 2: Record the real baseline — every later task compares to this number**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

Write the `Tests  N passed (N)` number down. It was 300 before batches A/B/C; it will be higher now. **If this run is red, stop** — you inherited a broken `main` and this plan cannot proceed on top of it.

- [ ] **Step 3: Fix P0-7 — 「移除（已退訂）」 lies about paused subscriptions**

`git grep -n "已退訂" -- packages README.md README.zh-TW.md`

The sync preview's remove-list is computed from `sub_status !== "active"`, so **paused** subscriptions land in it — and pausing is the *main* path (a `FALSE` cell in the CSV import pauses a subscription, and the import warning then tells the admin to run the sync). Replace the heading:

```tsx
{diff.remove.length > 0 && <DiffList title="移除（訂閱已暫停／已取消）" rows={diff.remove.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
```

Both READMEs repeat the same wrong claim in their 重新同步 bullet — fix them in this commit:

- `README.zh-TW.md`: `（補缺漏 · 移除已退訂 · 待繳改現價 · 已繳／已驗證凍結）` → `（補缺漏 · 移除已暫停／已取消的訂閱 · 待繳改現價 · 已繳待驗／已驗證凍結）`
- `README.md`: `(add missing · remove de-subscribed · reprice pending · freeze settled)` → `(add missing · remove paused/cancelled · reprice pending · freeze settled)`

- [ ] **Step 4: Fix P0-8 — `/繳費` says the three fields are optional, in both copies**

```bash
git grep -n "可選渠道" -- packages
```

Expect **two** hits: `src/adapters/discord/commands.ts` and `scripts/register-commands.mjs`. The handler rejects a submit where 渠道, 截圖 and 備註 are all empty, so "可選" sends members straight into a wall. Use issue #46's wording verbatim in `commands.ts`:

```ts
export const PAY_COMMAND = {
  name: "繳費",
  type: 1,
  description: "登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註 至少填一項）",
  options: [
    { type: OPT_STRING, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
    { type: OPT_ATTACHMENT, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false },
    { type: OPT_STRING, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
  ],
};
```

and the identical string in `scripts/register-commands.mjs`:

```js
    name: "繳費", type: 1,
    description: "登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註 至少填一項）",
```

- [ ] **Step 5: Assert both concepts are gone, and that the two payload copies agree**

```bash
git grep -n "已退訂" -- packages README.md README.zh-TW.md ; echo "expect: no output"
git grep -n "可選渠道\|，可選" -- packages ; echo "expect: no output"
git grep -h "登記繳費（一次涵蓋" -- packages | sed 's/^ *//' | sort -u | wc -l
echo "expect: 1 — the .ts and .mjs descriptions are byte-identical"
```

The first two must print nothing; the third must print `1`.

- [ ] **Step 6: Run the suite**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

Expected: PASS, same count as Step 2.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src/views/Payments.tsx packages/worker/src/adapters/discord/commands.ts \
        packages/worker/scripts/register-commands.mjs README.md README.zh-TW.md
git commit -m "fix(copy): 同步預覽不再把「暫停」講成「已退訂」;/繳費 描述改為「至少填一項」 (#46)"
```

---

## Task 2: 核准 → 驗證

**Files:**
- Modify: every file `git grep -l "核准" -- packages README.md README.zh-TW.md` reports — expected: `admin/src/views/MemberReview.tsx`, `admin/src/views/PaymentDetail.tsx`, `admin/src/views/Payments.tsx`, `worker/src/routes/admin.ts`, `worker/src/core/payments.ts`, `worker/test/core/payments-verify-all.test.ts`, `README.md`, `README.zh-TW.md`
- Test: `packages/worker/test/core/payments-verify-all.test.ts`, `packages/worker/test/routes/payments-review.test.ts`

**Interfaces:**
- Consumes: branch `ux/46-terminology` from Task 1.
- Produces: `核准` reaches zero occurrences under `packages/` and both READMEs. Later tasks may assume 驗證 is the only verb.

- [ ] **Step 1: Regenerate the edit-site list**

```bash
git grep -n "核准" -- packages README.md README.zh-TW.md
```

Every hit is in scope, **including English code comments and the `describe()` title** — the codebase's own vocabulary counts.

- [ ] **Step 2: Apply §A.1 to the admin SPA**

`MemberReview.tsx` — the bulk action, its result banner, the per-row button, and the two comments:

```tsx
                const r = await api.verifyAll(userId, period);
                return outstanding.length > 0
                  ? `已驗證 ${r.verified} 筆，另 ${outstanding.length} 筆（待繳／已退回）需逐筆處理`
                  : `已驗證 ${r.verified} 筆`;
```

```tsx
              {/* 全部 is only true when every row is 已繳待驗; otherwise name the subset the sweep covers. */}
              <IconCheck />{busy ? "處理中…" : outstanding.length > 0
                ? `驗證已繳待驗（${reviewable.length} 筆）`
                : `一鍵全部驗證（${reviewable.length} 筆）`}
```

```tsx
                    <button className="btn iconlbl" disabled={busy} title="標記為「已驗證」（帶入申報渠道）"
                      onClick={() => run(async () => { await api.verify(p.id, null); return null; })}>
                      <IconCheck />驗證
                    </button>
```

and in the file header comment plus the reload comment, `一鍵全部核准` → `一鍵全部驗證`, `per-row 核准／退回` → `per-row 驗證／退回`.

`PaymentDetail.tsx` — the primary action label (it sits next to `撤回驗證`, so `驗證`/`撤回驗證` now reads as one pair):

```tsx
        {canVerify && <button className="btn btn--primary" disabled={busy} onClick={() => run(() => api.verify(payment.id, tagId === "" ? null : Number(tagId)))}>驗證</button>}
```

`Payments.tsx` — the QuickVerify tooltip (`標記已驗證（帶入申報渠道）` → `標記為「已驗證」（帶入申報渠道）`); its button label is already `驗證`.

- [ ] **Step 3: Apply §A.1 to the worker**

`routes/admin.ts` — the partial-batch error and the handler's doc comment:

```ts
    return errorResponse(500, `批次驗證中斷，已驗證 ${paymentIds.length} 筆：${message}`, {
      verified: paymentIds.length, payment_ids: paymentIds,
    });
```

```ts
 * 一鍵全部驗證: verify every reviewable payment this member has in the period. A single member
```

`core/payments.ts` — the `verifyUserPeriod` doc comment: `一鍵全部核准:` → `一鍵全部驗證:`.

- [ ] **Step 4: Update the test that names the old term**

`packages/worker/test/core/payments-verify-all.test.ts`:

```ts
describe("verifyUserPeriod (一鍵全部驗證)", () => {
```

`payments-review.test.ts` asserts on `模擬硬錯誤` (the *inner* message), which the new wrapper still carries — leave it, and let Step 6 prove it.

- [ ] **Step 5: Update both READMEs**

`README.md` — three `一鍵全部核准` → `一鍵全部驗證`.
`README.zh-TW.md` — `一鍵全部核准` ×2 → `一鍵全部驗證`; `可單筆核准／退回` → `可單筆驗證／退回`; `一鍵掃過去核准` → `一鍵掃過去驗證`; `可一鍵核准` → `可一鍵驗證`.

- [ ] **Step 6: Zero-hits assertion + suite**

```bash
git grep -n "核准" -- packages README.md README.zh-TW.md ; echo "expect: no output"
pnpm --filter @chippot/worker test 2>&1 | tail -6
pnpm --filter @chippot/admin run typecheck
```

Expected: grep silent; tests PASS at the Task 1 baseline count; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src packages/worker/src packages/worker/test README.md README.zh-TW.md
git commit -m "refactor(copy): 驗證動作統一為「驗證」,刪除「核准」 (#46)"
```

---

## Task 3: `paid` 狀態統一為「已繳待驗」

**Files:**
- Modify: `packages/admin/src/ui.tsx` (`STATUS_LABEL`), `packages/admin/src/views/Dashboard.tsx`, `packages/admin/src/views/Payments.tsx`, `README.zh-TW.md`
- Test: worker suite (regression only — the admin has no test runner)

**Interfaces:**
- Consumes: Task 2's 驗證 vocabulary.
- Produces: `已繳` never appears alone as a status label; `已繳待驗` / `待驗` are the only forms.

- [ ] **Step 1: Regenerate the edit-site list**

```bash
git grep -n "已繳" -- packages README.md README.zh-TW.md
```

Hits that already read `已繳待驗` or `已繳／已驗證` are **correct** — do not touch them. You are hunting bare `已繳`.

- [ ] **Step 2: Fix the badge — the single highest-value edit in this task**

`packages/admin/src/ui.tsx`:

```tsx
const STATUS_LABEL: Record<string, string> = {
  pending: "待繳", paid: "已繳待驗", verified: "已驗證", rejected: "已退回",
};
```

- [ ] **Step 3: Fix the Dashboard**

The 各方案 table header (7 columns — use the short form) and the no-proof stat (which counts `paid` **and** `verified`, per the reconcile SQL):

```tsx
                  <tr><th>方案</th><th className="right">筆數</th><th className="right">待繳</th><th className="right">待驗</th><th className="right">已驗證</th><th className="right">應收</th><th className="right">已驗證金額</th></tr>
```

```tsx
            <Stat label="純聲明（已繳待驗、已驗證）" value={data.no_proof_count} />
```

(That stat also settles §A.8 — 無憑證 survives only as explanatory prose.)

- [ ] **Step 4: Fix the two frozen-count labels and the retract success line**

The frozen set is `paid` + `verified`, so the old `保留(已繳)` was inaccurate as well as inconsistent. In **both** `SyncModal` and `RetractModal`:

```tsx
            <Stat label="🔒 保留（已繳待驗、已驗證）" value={diff.frozen_count} />
```

```tsx
            <Stat label="🔒 保留（已繳待驗、已驗證）" value={preview.frozen_count} />
```

and the retract success line:

```tsx
      setDone(`已收回 ${period}：刪除 ${r.applied.removed} 筆帳單、保留 ${r.applied.frozen} 筆已繳待驗／已驗證。此期已回到未開繳狀態。`);
```

(The `此期` here anticipates Task 4; if you write `本期` now, Task 4 will catch it — but write it right the first time.)

- [ ] **Step 5: README**

`README.zh-TW.md` — `把每筆 pending/rejected 標記為「已繳」` → `標記為「已繳待驗」`. Leave `誰欠／已繳／已驗證` in the intro paragraph: that sentence is about money in general, not the status label. Leave `已繳／已驗證凍結` and `已繳待驗` untouched.

- [ ] **Step 6: Zero-hits assertion + gates**

```bash
git grep -n "已繳" -- packages README.md README.zh-TW.md | grep -v "已繳待驗" | grep -v "已繳／已驗證"
echo "expect: only README.zh-TW's 誰欠／已繳／已驗證 intro line"
pnpm --filter @chippot/worker test 2>&1 | tail -6
pnpm --filter @chippot/admin run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src README.zh-TW.md
git commit -m "refactor(copy): paid 狀態一律顯示「已繳待驗」,凍結筆數改為「已繳待驗、已驗證」 (#46)"
```

---

## Task 4: 期別叢集 — 本期 → 此期／實際期別,開帳 → 開繳,按鈕名對齊

The three findings the synthesis report deferred to batch E (D3, D5, D7). E is not happening, so they land here. They touch the same lines, so they ship as one commit.

**Files:**
- Modify: whatever `git grep -l "本期\|開帳"` reports — expected `admin/src/views/Payments.tsx`, `admin/src/views/Dashboard.tsx`, `admin/src/views/Settings.tsx`, `worker/src/adapters/discord/handler.ts`, `worker/src/adapters/discord/commands.ts`, `worker/scripts/register-commands.mjs`, `README.md`, `README.zh-TW.md`
- Modify: `packages/worker/scripts/register-commands.mjs` — it duplicates `INITIATE_COMMAND.description` (same "keep in sync" duplication Task 1 hit for `PAY_COMMAND`)
- Test: `packages/worker/test/adapters/discord-pay.test.ts` (asserts the old 本期 string)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `本期` and `開帳` reach zero. The sync button's label is exactly `重新同步此期帳單`, which Settings' import warning quotes verbatim.

- [ ] **Step 1: Regenerate both edit-site lists**

```bash
git grep -n "本期" -- packages README.md README.zh-TW.md
git grep -n "開帳" -- packages README.md README.zh-TW.md
```

**Expect some 本期 hits to be already gone** — UX-A owns finding A5 (the 發起繳費 wording). Whatever A left behind, you fix.

- [ ] **Step 2: Apply §A.3 to the Payments toolbar and its two modals**

```tsx
        <button className="btn" disabled={!effPeriod} title={effPeriod ? "對齊此期帳單到目前名單／現價" : "請先選擇單一期別"} onClick={() => setSync(true)}>重新同步此期帳單</button>
        <button className="btn btn--danger" disabled={!effPeriod} title={effPeriod ? "刪除此期未繳／已退回帳單,期別回到未開繳" : "請先選擇單一期別"} onClick={() => setRetract(true)}>收回此期開繳</button>
```

**If UX-A already rewrote the retract tooltip** (its P0-4 adds the 已退回 + upload-link consequences), keep A's sentence and change only its `本期` → `此期`. Do not revert A's work.

Modal titles:

```tsx
    <Modal title={`重新同步此期帳單 · ${period}`} onClose={onClose}>
```

```tsx
    <Modal title={`收回此期開繳 · ${period}`} onClose={onClose}>
```

The remaining prose in those modals:

```tsx
            ? <p style={{ color: "var(--muted)" }}>此期已是最新，無需變更。</p>
```

```tsx
            : <p style={{ color: "var(--muted)" }}>此期沒有可刪除的未繳／已退回帳單,收回只會把期別改回「未開繳」。</p>}
```

```tsx
            收回後此期回到「未開繳」：刪掉的帳單不會被「重新同步此期帳單」補回來,日後可以再次發起繳費（屆時會重新發送開繳通知）。
            {preview.frozen_count > 0 && `已繳／已驗證的 ${preview.frozen_count} 筆一律原樣保留,重開此期也不會重複產生帳單。`}
            已經發出的 Discord 開繳通知不會撤回,必要時請自行到頻道說明。
```

(The last block also kills the final `開帳`. Note the commas above are the file's existing full-width `，` — keep whatever the file already uses; do not convert punctuation here, §A.10's rules cover separators, not commas.)

- [ ] **Step 3: Dashboard empty states**

```tsx
                  {data.by_plan.length === 0 && <tr><td colSpan={7}><Empty>此期尚無資料</Empty></td></tr>}
```

```tsx
                  {data.by_channel_tag.length === 0 && <tr><td colSpan={3}><Empty>此期尚無已驗證款項</Empty></td></tr>}
```

- [ ] **Step 4: Settings — the two 開帳 hints, the ActionRow description, and the button-name reference (D7)**

```tsx
            <Field label="每月結帳日"><span className="field__hint">每月幾號自動向所有成員開繳（1-28）。</span><input type="number" min={1} max={28} value={form.billing_day} onChange={(e) => set("billing_day")(e.target.value)} disabled={busy} /></Field>
            <Field label="逾期天數"><span className="field__hint">開繳後幾天仍未繳就列入催繳。</span><input type="number" min={0} value={form.overdue_days} onChange={(e) => set("overdue_days")(e.target.value)} disabled={busy} /></Field>
```

(The `1–28` → `1-28` en-dash fix from §A.10 rule 2 rides along — it is the same string.)

```tsx
          <ActionRow title="發起繳費" tag="會改價＋發通知" warn desc="確認所選期別的金額並向所有成員發出開繳通知。"><InitiateBilling billingDay={savedBillingDay} dirty={dirty} /></ActionRow>
```

The import warning must now quote the button **exactly**:

```tsx
                被暫停的訂閱在 {diff.period} 還有 {diff.affected_pending_bills.length} 筆未繳帳單。匯入<b>不會</b>變更任何帳單；請到「繳費審核」按<b>「重新同步此期帳單」</b>清理。
```

- [ ] **Step 5: Discord — interpolate the real period everywhere**

`commands.ts`:

```ts
export const INITIATE_COMMAND = {
  name: "發起繳費",
  type: 1,
  description: "（管理員）確認指定期別各方案金額並發出開繳通知",
  default_member_permissions: MANAGE_GUILD,
};
```

and its duplicate in `scripts/register-commands.mjs`:

```js
    name: "發起繳費", type: 1,
    description: "（管理員）確認指定期別各方案金額並發出開繳通知",
    default_member_permissions: "32",
```

`handler.ts` — five replies. `period`/`current` is in scope at every one of them (verify with the grep before editing; if UX-A moved a block, the variable name may differ):

```ts
    return opened ? "✅ 你已登記繳費，目前沒有待繳項目。" : `${current} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`;
```

```ts
  if (r.paidCount === 0) return `${period} 已登記繳費，無需重複操作。`;
  const ignoredNote = screenshotIgnored ? "（本站未開啟截圖功能，已記錄你的繳費宣告）" : "";
  return `✅ 已登記 ${period} 繳費 NT$${r.totalAmount.toLocaleString()}（共 ${r.paidCount} 筆）。管理員確認收款後完成。${ignoredNote}`;
```

```ts
        : `✅ 已更新 ${period} 金額（更新 ${r.updatedPlans} 個方案、${r.updatedPayments} 筆待繳）。${period} 的通知先前已發送，未重複發送。`;
```

```ts
      content: opened ? "✅ 你已登記繳費，目前沒有待繳項目。" : `${current} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`,
```

```ts
  if (!(await isBillingOpened(env.DB, ws, period))) {
    return updateErr(`${period} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`);
  }
```

```ts
      return json({ type: RT_UPDATE_MESSAGE, data: { content: `✅ ${period} 已登記繳費，無需重複操作。`, components: [] } });
```

- [ ] **Step 6: Update the test that asserts the old string**

`packages/worker/test/adapters/discord-pay.test.ts` asserts `expect(captured).toContain("已登記本期")`. The reply now interpolates the period, so assert on the stable half:

```ts
    expect(captured).toContain("已登記");
    expect(captured).toMatch(/\d{4}-\d{2}/);   // the reply now names the real period, not 「本期」
    expect(captured).toContain("已記錄你的繳費宣告");
```

- [ ] **Step 7: Run the suite to confirm nothing else asserted these strings**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -20
```

Expected: PASS at the baseline count. **If a different test fails, read its assertion and update it in this task** — do not defer it.

- [ ] **Step 8: READMEs**

`README.md` — `重新同步本期帳單` ×2 → `重新同步此期帳單`; the 發起繳費 bullet's `confirm this period's per-plan amounts` → `confirm the selected period's per-plan amounts` (the English prose carries the same "this period" inaccuracy as the zh-TW copy — the default is often *next* month).
`README.zh-TW.md` — `重新同步本期帳單` ×2 → `重新同步此期帳單`; `確認本期各方案金額` → `確認指定期別各方案金額`; `ephemeral：列出本期各方案 + 總額` → `列出該期各方案 + 總額`; `自動開帳` → `自動開繳`; the architecture diagram's `— 開帳 / 催繳 / 保存期` → `— 開繳 / 催繳 / 保存期`.

- [ ] **Step 9: Zero-hits assertions + gates**

```bash
git grep -n "本期" -- packages README.md README.zh-TW.md ; echo "expect: no output"
git grep -n "開帳" -- packages README.md README.zh-TW.md ; echo "expect: no output"
pnpm --filter @chippot/worker test 2>&1 | tail -6
pnpm -r typecheck
```

- [ ] **Step 10: Commit**

```bash
git add packages/admin/src packages/worker/src packages/worker/test README.md README.zh-TW.md
git commit -m "refactor(copy): 期別標籤改「此期」／實際期別,開帳→開繳,按鈕名與文案對齊 (#46)"
```

---

## Task 5: 期別（後台）vs 月份（成員面）

**Files:**
- Modify: `packages/web/src/App.tsx`
- Test: worker suite (regression)

**Interfaces:**
- Consumes: Task 4.
- Produces: `期別` exists only under `packages/admin` and `packages/worker`; `月份` on the member surfaces plus the two documented CSV-import exceptions.

- [ ] **Step 1: Regenerate both lists**

```bash
git grep -n "期別" -- packages/web packages/worker/src/adapters
git grep -n "月份" -- packages/admin
```

- [ ] **Step 2: The member pay page says 月份, like Discord already does**

`packages/web/src/App.tsx`, in `Stub`:

```tsx
      <div className="stub__row">
        <span className="stub__label">月份</span>
        <span className="stub__period">{period}</span>
      </div>
```

- [ ] **Step 3: Confirm the Discord side needs nothing**

`git grep -n "期別" -- packages/worker/src/adapters` must print nothing — Discord already says 月份 (`選擇要繳的月份`, `你有多個月份待繳`, `這個月份已無待繳項目`). If a hit appears, it arrived from batch A or C; convert it to 月份 here.

- [ ] **Step 4: Zero-hits assertion, with the documented exception spelled out**

```bash
git grep -n "期別" -- packages/web packages/worker/src/adapters ; echo "expect: no output"
git grep -n "月份" -- packages/admin
```

The second grep must return **exactly two** `Settings.tsx` lines — the CSV import's `起算月份第一天（選填，YYYY-MM-DD）` field label and the `起算月份留空＝當月` prose. Those describe a `YYYY-MM-DD` **date**, not a billing period, so 期別 would be wrong (§A.4). Anything else is a leak; fix it.

- [ ] **Step 5: Gates**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -6
pnpm --filter @chippot/web run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "refactor(copy): 成員繳費頁改稱「月份」,與 Discord 一致（後台維持「期別」） (#46)"
```

---

## Task 6: 支付渠道 → 繳費渠道

**Files:**
- Modify: `packages/admin/src/App.tsx`, `packages/admin/src/views/Manage.tsx`
- Test: worker suite (regression)

**Interfaces:**
- Consumes: Task 5.
- Produces: `支付渠道` reaches zero; `繳費渠道` is the full name, `渠道` stays as the table/field short form.

- [ ] **Step 1: Regenerate**

```bash
git grep -n "支付渠道" -- packages README.md README.zh-TW.md
```

- [ ] **Step 2: Nav label**

```tsx
  { id: "tags", label: "繳費渠道", el: <ChannelTags /> },
```

- [ ] **Step 3: Card title and delete confirmation**

```tsx
      <Card title="繳費渠道（對帳分組）" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增渠道…</button>}>
```

```tsx
          message={`確定刪除此繳費渠道？此操作無法復原。`}
```

(The `…` on 新增渠道 is §A.10 rule 5 — a header action opening a modal. Task 13 sweeps the rest; doing this one here avoids touching the line twice.)

- [ ] **Step 4: Zero-hits assertion + gates**

```bash
git grep -n "支付渠道" -- packages README.md README.zh-TW.md ; echo "expect: no output"
pnpm --filter @chippot/admin run typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src
git commit -m "refactor(copy): 後台「支付渠道」統一為「繳費渠道」 (#46)"
```

---

## Task 7: 成員備註、純聲明、繳費頻道、去人稱

Four one-line convergences that share no other task's files-of-record. One commit.

**Files:**
- Modify: `packages/admin/src/views/PaymentDetail.tsx`, `packages/admin/src/views/Manage.tsx`, `packages/admin/src/views/Settings.tsx`
- Test: worker suite (regression)

**Interfaces:**
- Consumes: Task 6.
- Produces: `使用者` and `帳單頻道` reach zero; no gendered pronoun refers to a member.

- [ ] **Step 1: Regenerate all four lists**

```bash
git grep -n "使用者" -- packages
git grep -n "帳單頻道" -- packages README.md README.zh-TW.md
git grep -n "無憑證" -- packages
git grep -nE "他可|到他|他的" -- packages
```

- [ ] **Step 2: 使用者備註 → 成員備註 (§A.7)**

`PaymentDetail.tsx` — the same data is already called 成員備註 in `MemberReview.tsx`:

```tsx
        {payment.payment_note && (<><dt>成員備註</dt><dd>{payment.payment_note}</dd></>)}
```

- [ ] **Step 3: 帳單頻道 → 繳費頻道 (§A.6)**

`Settings.tsx` — the bind-button ActionRow. This also drops the pronoun (§A.13):

```tsx
          <ActionRow title="張貼／更新綁定按鈕訊息" tag="立即執行" desc="在繳費頻道貼一則含「綁定 Discord」按鈕的公開訊息，讓成員主動綁定（開繳／催繳才 @ 得到）。"><RebuildBindMessage /></ActionRow>
```

- [ ] **Step 4: Drop the pronoun in the unbind confirmation (§A.13)**

`Manage.tsx`:

```tsx
    if (!user || !window.confirm("確定解除這位成員的 Discord 綁定？解除後可重新用綁定按鈕／指令綁定。")) return;
```

- [ ] **Step 5: Confirm 無憑證 survives only as prose (§A.8)**

The `無憑證` grep must now return exactly the two identical explanatory sentences — `無憑證，純聲明 — 請依備註與帳戶自行核對。` in `PaymentDetail.tsx` and `MemberReview.tsx`. The Dashboard stat label was already converted in Task 3. If a third hit exists, convert it to 純聲明.

- [ ] **Step 6: Zero-hits assertions + gates**

```bash
git grep -n "使用者" -- packages ; echo "expect: no output"
git grep -n "帳單頻道" -- packages README.md README.zh-TW.md ; echo "expect: no output"
git grep -nE "他可|到他" -- packages ; echo "expect: no output"
pnpm --filter @chippot/admin run typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src
git commit -m "refactor(copy): 成員備註／繳費頻道用詞收斂,並移除對成員的第三人稱 (#46)"
```

---

## Task 8: enum 中文化（顯示層對映）

The admin shows raw DB enums in four places and one sentence even teaches admins to pick `cancelled` by name. Add display maps following the `CHANNEL_TYPE_LABEL` precedent already in `Manage.tsx`.

**READ THIS FIRST:** every `<option value=…>`, every request body, every SQL literal keeps its English value. Only the text between the tags changes. A diff that changes `value="active"` is wrong.

**Files:**
- Modify: `packages/admin/src/views/PaymentDetail.tsx`, `packages/admin/src/views/Manage.tsx`
- Test: worker suite (regression — this task must not move a single assertion)

**Interfaces:**
- Consumes: Task 7.
- Produces: `SOURCE_LABEL` (exported from `PaymentDetail.tsx`) and `SUB_STATUS_LABEL` (module-local in `Manage.tsx`), both `Record<string, string>` with a `?? raw` fallback.

- [ ] **Step 1: Regenerate**

```bash
git grep -n "payment.source\|{s.status}\|>provider<\|cancelled" -- packages/admin/src
```

- [ ] **Step 2: `source` map in `PaymentDetail.tsx`**

Place it above the component. The `?? payment.source` fallback matters: a future enum value must degrade to the raw string, never render blank.

```tsx
// payments.source is a DB enum (migrations/0001_init.sql). Display only — the stored value never changes.
// 'user' is the schema default that no current code path writes, so it only appears on legacy rows;
// 'cron' covers every bill the system creates (daily cron, 發起繳費 and 重新同步 all leave source unset).
const SOURCE_LABEL: Record<string, string> = {
  user: "Discord（舊版）",
  user_slash: "Discord",
  user_web: "網頁上傳",
  admin_manual: "後台補登",
  cron: "系統建立",
};
```

```tsx
        <dt>來源</dt><dd>{SOURCE_LABEL[payment.source] ?? payment.source}</dd>
```

- [ ] **Step 3: 訂閱狀態 map in `Manage.tsx`**

Put it beside the existing `CHANNEL_TYPES` / `CHANNEL_TYPE_LABEL` pair so the two follow one shape:

```tsx
// subscriptions.status is a DB enum — display only, the <option value> below stays English.
const SUB_STATUSES = [
  { v: "active", label: "啟用中" },
  { v: "paused", label: "暫停" },
  { v: "cancelled", label: "已取消" },
];
const SUB_STATUS_LABEL: Record<string, string> = Object.fromEntries(SUB_STATUSES.map((s) => [s.v, s.label]));
```

The subscriptions table cell:

```tsx
                  <td>{s.user_name}</td><td>{s.plan_name}</td><td>{SUB_STATUS_LABEL[s.status] ?? s.status}</td><td className="mono">{s.start_date}</td><td className="right mono">{s.billing_day}</td>
```

The edit modal's `<select>` — **values stay English**:

```tsx
      <Field label="狀態"><select value={f.status} onChange={(e) => set("status", e.target.value)} disabled={busy}>{SUB_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select></Field>
```

- [ ] **Step 4: Stop teaching the raw enum, and translate the `provider` label**

The delete-subscription confirmation:

```tsx
          message={`將一併刪除此訂閱的 ${del.payment_count ?? 0} 筆繳費紀錄。\n此操作無法復原。（若只想停收，可改用「編輯 → 狀態：已取消」）`}
```

The plans table header, the plan modal's field label, and its validation message:

```tsx
            <thead><tr><th>名稱</th><th>供應商</th><th className="right">月費</th><th>身分組 ID</th><th>啟用</th><th></th></tr></thead>
```

```tsx
    if (!provider) { setErr("請填供應商"); return; }
```

```tsx
      <Field label="供應商（選現有或直接輸入新的，如 gemini、glm）">
```

The `<datalist id="plan-providers">` id and the `provider` variable names are code, not copy — leave them.

- [ ] **Step 5: Prove no DB value moved**

```bash
git diff -- packages/admin/src | grep -E '^\+.*value="(active|paused|cancelled|user|user_slash|user_web|admin_manual|cron)"'
```

Every line this prints must be an `<option>` whose `value` is unchanged from the line above it in the diff. If the grep shows a *changed* value, revert that hunk.

- [ ] **Step 6: Zero-hits assertion + gates**

```bash
git grep -n ">provider<\|狀態 cancelled" -- packages/admin/src ; echo "expect: no output"
pnpm --filter @chippot/admin run typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

The worker suite must be at the baseline count **and unchanged** — this task touches no worker file.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src
git commit -m "feat(admin-ui): 來源／訂閱狀態／供應商改顯示中文（顯示層對映,DB 值不變） (#46)"
```

---

## Task 9: 「至少填一項」與成員面語氣

**Files:**
- Modify: `packages/worker/src/adapters/discord/handler.ts`, `packages/web/src/App.tsx`, `packages/web/src/api.ts`, `packages/web/index.html`, `packages/worker/src/env.ts`
- Test: `packages/worker/test/adapters/discord-handler.test.ts` (asserts `至少`), `packages/worker/test/env.test.ts` (asserts the default template's shape)

**Interfaces:**
- Consumes: Task 8.
- Produces: one canonical at-least-one sentence (§A.12) on all three member surfaces.

- [ ] **Step 1: Regenerate**

```bash
git grep -n "至少" -- packages
git grep -n "開始繳費" -- packages
```

- [ ] **Step 2: Discord — the rejection message**

```ts
    if (screenshotIgnored) return "本站未開啟截圖功能，請改用「渠道」或「備註」登記繳費。";
    return "渠道、截圖、備註至少填一項。";
```

- [ ] **Step 3: Web pay page — both copies of the rule, same order, same punctuation**

```tsx
    if (!canSubmit) {
      setError("渠道、截圖、備註至少填一項。");
      return;
    }
```

```tsx
        <p className="muted small center">{info?.proof_enabled === false ? "渠道、備註至少填一項。" : "渠道、截圖、備註至少填一項。"}此連結僅限你本人本期使用，送出後即失效。</p>
```

Note that trailing sentence still says 本期 — it means "the period this link is for", and the link **is** single-period. Rewrite it to remove the word anyway, since Task 4 banned it:

```tsx
        <p className="muted small center">{info?.proof_enabled === false ? "渠道、備註至少填一項。" : "渠道、截圖、備註至少填一項。"}此連結僅限你本人、此月份使用，送出後即失效。</p>
```

- [ ] **Step 4: Web — sentence-final punctuation and the page title (§A.13)**

`packages/web/src/api.ts`:

```ts
    return { ok: false, error: "連線失敗，請稍後再試。" };
```

`packages/web/index.html`:

```html
    <title>ChipPot · 繳費登記</title>
```

- [ ] **Step 5: The default 開繳 template's one-off wording (§A.5)**

`packages/worker/src/env.ts`:

```ts
  billing_opened_template: "📢 **{period} 開繳**\n{plans}\n\n請點下方「繳費」按鈕，或使用 `/繳費` 指令（可附截圖）。",
```

This is a **default**; workspaces with a saved template are unaffected. `env.test.ts` asserts the default's shape (`toEqual(DEFAULT_SETTINGS)`, `toContain("{plans}")`), not its prose — Step 6 proves it.

- [ ] **Step 6: Zero-hits assertion + suite**

```bash
git grep -n "開始繳費" -- packages ; echo "expect: no output"
git grep -n "至少" -- packages/worker/src packages/web/src
pnpm --filter @chippot/worker test 2>&1 | tail -20
```

The second grep must show the identical sentence `渠道、截圖、備註至少填一項。` (plus the no-R2 variant) and nothing else — no `請至少附上…`, no `請至少選擇…`. The suite must PASS: `discord-handler.test.ts` asserts `toContain("至少")`, which the new sentence still satisfies.

- [ ] **Step 7: Gates + commit**

```bash
pnpm -r typecheck
git add packages/worker/src packages/web
git commit -m "refactor(copy): 「渠道、截圖、備註至少填一項。」統一三個成員入口,並修正頁面標題與句末標點 (#46)"
```

---

## Task 10: 後台錯誤訊息中文化 (D14)

These change **API response strings**, so they get real tests. TDD: write the assertions first, watch them fail against the English strings, then translate.

**Files:**
- Modify: `packages/worker/src/routes/admin.ts`
- Test: `packages/worker/test/routes/admin.test.ts`

**Interfaces:**
- Consumes: Task 9.
- Produces: every `errorResponse` in `routes/admin.ts` that an admin can reach by clicking now answers in zh-TW. The format-validator allowlist in §A.14 stays English **by design** — a later task must not "finish the job".

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/routes/admin.test.ts`. Read the file's existing `call(...)` helper and seeded fixtures first and match them — the helper's signature and the seeded ids are what the rest of the file uses, and this block must not introduce a second convention.

Route paths verified against `buildAdminRouter()` at the bottom of `routes/admin.ts`: there is **no** `GET /admin/users/:id` (only the list), and initiate is `POST /admin/billing/initiate` with the period **in the body** — not a path param.

```ts
// #46: the admin SPA renders `data.error` straight into .error-banner, so anything reachable by
// clicking must be zh-TW. Format validators behind type="month"/type="number" stay English on purpose.
describe("admin error messages are zh-TW (#46)", () => {
  it("404s in Chinese for an unknown member", async () => {
    const res = await call("PATCH", "/admin/users/999999", { display_name: "x" });
    expect(res!.status).toBe(404);
    expect(((await res!.json()) as any).error).toContain("找不到這位成員");
  });

  it("names the missing Discord channel setting in Chinese", async () => {
    const res = await call("POST", "/admin/discord/bind-message");
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toContain("繳費頻道 ID");
  });

  it("keeps format validators in English (unreachable from the UI)", async () => {
    const res = await call("POST", "/admin/billing/initiate", { period: "not-a-period", amounts: [] });
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toBe("period must be YYYY-MM");
  });
});
```

Match the file's existing preconditions. The bind-message test needs `discord_billing_channel_id` **unset** and the bot token **set** (the handler checks the channel first, then the token) — `admin.test.ts` already has a save/restore pattern for `DISCORD_BOT_TOKEN` ("Supply the bot token locally (CI has no .dev.vars), then restore it"); reuse it rather than inventing a second approach. If the seed sets a billing channel, clear it in the test and restore it afterwards.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @chippot/worker test -- routes/admin 2>&1 | tail -25
```

Expected: the first two FAIL (`expected 'not found' to contain '找不到這位成員'`), the third PASSES (it asserts the status quo).

- [ ] **Step 3: Translate — §A.14's in-scope table, and only it**

```bash
git grep -n 'errorResponse(4\|errorResponse(5' -- packages/worker/src/routes/admin.ts
```

Walk the list. For each hit, decide from §A.14: in the zh-TW table → translate; in the English allowlist → leave. For the six `not found` sites, pick the entity from the surrounding handler name (`getUserHandler` → `找不到這位成員`, `updateSubscriptionHandler` → `找不到這筆訂閱`, and so on) — a bare `找不到資料` for all of them is worse copy and this task rejects it.

Do **not** introduce a `notFound(entity)` helper. Six literals in six handlers read better in review than one indirection, and the strings differ.

- [ ] **Step 4: Run the whole worker suite**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -20
```

Expected: PASS, count = baseline **+3**. If a pre-existing test fails, it asserted an English string this task changed — update that assertion here, in this commit.

- [ ] **Step 5: Assert the allowlist survived**

```bash
git grep -n "period must be YYYY-MM" -- packages/worker/src/routes/admin.ts | wc -l
```

Expected: **10** — the count on 2026-07-31, unchanged by this task. These are load-bearing English-by-design (§A.14's allowlist); if the number dropped, you over-translated. If batches A/B/C added or removed a period validator, run this grep **before** Step 3 too and compare against your own before-number rather than 10.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/admin.ts packages/worker/test/routes/admin.test.ts
git commit -m "feat(worker): 後台可觸及的錯誤訊息改為中文（格式驗證維持英文） (#46)"
```

---

## Task 11: 狀態競態錯誤中文化 (D15)

`payment 1042 cannot transition to 'verified'` is a **reproducible race** (two admins, or a stale list), not a crash — but it reaches the admin's error banner looking like one.

**Files:**
- Modify: `packages/worker/src/core/payments.ts`
- Test: `packages/worker/test/core/payments.test.ts`

**Interfaces:**
- Consumes: Task 10.
- Produces: `InvalidPaymentTransition`'s `message` is zh-TW; its `paymentId` and `to` public readonly fields are unchanged, so logs and tests keep the detail the message no longer carries.

- [ ] **Step 1: Write the failing test**

Append to `packages/worker/test/core/payments.test.ts` (it already imports `InvalidPaymentTransition`):

```ts
// #46: this is a reproducible race (two admins, or a stale list), so the message the admin sees must
// say what to do — while the id/target stay on the error object for logs.
it("InvalidPaymentTransition explains the race in zh-TW and keeps its fields", () => {
  const e = new InvalidPaymentTransition(1042, "verified");
  expect(e.message).toBe("這筆的狀態已被變動（可能已由其他人處理），請重新載入後再試。");
  expect(e.paymentId).toBe(1042);
  expect(e.to).toBe("verified");
  expect(e.name).toBe("InvalidPaymentTransition");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @chippot/worker test -- core/payments 2>&1 | tail -20
```

Expected: FAIL — `expected 'payment 1042 cannot transition to …' to be '這筆的狀態已被變動…'`.

- [ ] **Step 3: Change the message, keep the fields**

```ts
export class InvalidPaymentTransition extends Error {
  constructor(
    public readonly paymentId: number,
    public readonly to: PaymentStatus
  ) {
    // Surfaced verbatim in the admin error banner (routes/admin.ts returns e.message on 409), so it
    // is copy, not a log line. paymentId/to stay on the instance for logs and tests.
    super("這筆的狀態已被變動（可能已由其他人處理），請重新載入後再試。");
    this.name = "InvalidPaymentTransition";
  }
}
```

- [ ] **Step 4: Run the whole suite**

```bash
pnpm --filter @chippot/worker test 2>&1 | tail -20
```

Expected: PASS, count = baseline **+4**. The three existing `rejects.toBeInstanceOf(InvalidPaymentTransition)` assertions are unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/core/payments.ts packages/worker/test/core/payments.test.ts
git commit -m "feat(worker): 狀態競態改回中文說明,不再像 crash（id/目標狀態保留在錯誤物件上） (#46)"
```

---

## Task 12: 千分位

A member sees `NT$1,258` in Discord and `NT$1258` for the same bill on the pay page.

**Files:**
- Modify: `packages/web/src/App.tsx`, `packages/admin/src/views/Manage.tsx`
- Test: worker suite (regression)

**Interfaces:**
- Consumes: Task 11.
- Produces: no rendered TWD amount without `.toLocaleString()`.

- [ ] **Step 1: Find every bare amount**

```bash
git grep -n 'NT\$\${' -- packages/web/src packages/admin/src
git grep -n 'NT\$' -- packages/web/src packages/admin/src | grep -v toLocaleString | grep -v "Money"
```

- [ ] **Step 2: Web pay page — per-subscription and total**

```tsx
          <span className="stub__amt">NT${s.amount.toLocaleString()}</span>
```

```tsx
          <span className="stub__amt">NT${total.toLocaleString()}</span>
```

- [ ] **Step 3: Admin — the plan `<select>` option and the plans table cell**

```tsx
      <Field label="方案"><select value={f.plan_id} onChange={(e) => set("plan_id", e.target.value)} disabled={busy}><option value="">選擇…</option>{plans.data?.plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}（NT${p.monthly_amount.toLocaleString()}）</option>)}</select></Field>
```

```tsx
                  <td>{p.name}</td><td>{p.provider}</td><td className="right mono">NT${p.monthly_amount.toLocaleString()}</td>
```

- [ ] **Step 4: Assertion + gates**

```bash
git grep -n 'NT\$' -- packages/web/src packages/admin/src | grep -v toLocaleString | grep -v "Money" | grep -v 'NT\$)'
pnpm -r typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

The grep must return **only static literals with no interpolation** — as of 2026-07-31 that is exactly three `Settings.tsx` lines: the `DEFAULT_NOTIFY` template string (`NT${amount}` is a *placeholder*, not a number), and the two `sampleVars()` preview strings, which already hardcode `NT$1,258` / `NT$1,573` with separators. Any line containing `${` followed by a numeric field is a miss — go fix it.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src packages/admin/src
git commit -m "fix(copy): 繳費頁與方案金額補上千分位,與 Discord／後台其他處一致 (#46)"
```

---

## Task 13: 格式與標點統一

Pure §A.10 work. Everything behaviour-adjacent has already shipped in Tasks 1–12; what remains is the `…` convention, the progress text, success prefixes and list separators.

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx`, `packages/admin/src/views/Manage.tsx`, `packages/admin/src/views/Settings.tsx`
- Test: worker suite (regression)

**Interfaces:**
- Consumes: Task 12.
- Produces: §A.10 rules 4, 5 and 6 hold across the admin SPA.

- [ ] **Step 1: Regenerate**

```bash
git grep -nE '計算中…|計算差異中…' -- packages/admin/src
git grep -nE 'setDone\(|setMsg\(|setToast\(' -- packages/admin/src
git grep -nE '新增成員|新增訂閱|新增方案|新增渠道|產生上傳連結|手動補登|匯入…|發起繳費…' -- packages/admin/src
git grep -n ' / ' -- packages/admin/src
```

- [ ] **Step 2: `…` on dialog-opening toolbar/header actions (rule 5)**

Add a trailing `…` to: `產生上傳連結…`, `手動補登…`, `重新同步此期帳單…`, `收回此期開繳…`, `新增成員…`, `新增訂閱…`, `新增方案…`. (`新增渠道…` shipped in Task 6; `匯入…` and `發起繳費…` already have it.)

**Do not** add `…` to row-level `編輯`／`刪除`／`停用`／`啟用`. They open dialogs too, but they repeat once per row and UX-B turned those rows into mobile cards where the extra glyph is pure noise. This asymmetry is deliberate — state it in the PR body so a reviewer does not "fix" it.

- [ ] **Step 3: Unify the preview progress text (rule 6)**

The retract preview computes a diff just like the sync preview:

```tsx
      {busy && !preview && <Empty>計算差異中…</Empty>}
```

- [ ] **Step 4: `✓ ` prefix on admin success messages (rule 4)**

`Payments.tsx` — the two that lack it:

```tsx
      setDone(`✓ 已套用：新增 ${r.applied.added}、移除 ${r.applied.removed}、改價 ${r.applied.repriced}、保留 ${r.applied.frozen}` + (r.notified ? `；已通知 ${r.notified} 位新成員` : ""));
```

```tsx
      setDone(`✓ 已收回 ${period}：刪除 ${r.applied.removed} 筆帳單、保留 ${r.applied.frozen} 筆已繳待驗／已驗證。此期已回到未開繳狀態。`);
```

- [ ] **Step 5: 頓號 for enumerations (rule 3)**

`Settings.tsx` — the import result line and the initiate result line, which use half-width slashes between Chinese items:

```tsx
      setDone(`✓ 已套用：新增 ${d.users_created.length} 人、新增 ${d.subs_added.length} 訂閱、恢復 ${d.subs_reactivated.length}、暫停 ${d.subs_paused.length}`);
```

```tsx
      setMsg(r.sent ? `✓ 已發出通知（更新 ${r.updated_plans} 方案、${r.updated_payments} 筆）` : `✓ 已更新金額（通知先前已發送）`);
```

Leave `PNG / JPG / WebP`, `Discord／Google Chat／Slack`, `openai / anthropic / gemini …` and file-path-ish strings alone — rule 3 is about Chinese enumerations.

- [ ] **Step 6: Assertions + gates**

```bash
git grep -n "計算中…" -- packages/admin/src ; echo "expect: no output"
git grep -nE 'setDone\(`[^✓]' -- packages/admin/src ; echo "expect: no output — every admin success line starts ✓"
pnpm --filter @chippot/admin run typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src
git commit -m "style(copy): 後台成功訊息前綴、中文頓號分隔、彈窗按鈕「…」與進度字統一 (#46)"
```

---

## Task 14: 標註 — 死設定、身分組承諾、寫死訊息

Three findings the audit raised where the honest resolution is *say what is true*, not rebuild. §A.15 explains why each stops here.

**Files:**
- Modify: `packages/worker/src/env.ts`, `packages/admin/src/views/Manage.tsx`, `packages/admin/src/views/Settings.tsx`, `packages/worker/src/adapters/discord/notify.ts`, `README.zh-TW.md`
- Test: worker suite (regression — annotations must not move a single assertion)

**Interfaces:**
- Consumes: Task 13.
- Produces: nothing other tasks depend on. This is the last content task.

- [ ] **Step 1: D22 — annotate the dead `timezone` setting**

There is **no admin UI field** for it; confirm before writing the comment:

```bash
git grep -n "timezone" -- packages
```

Expected: three hits, all in `packages/worker/src/env.ts`. Annotate the interface field:

```ts
export interface WorkspaceSettings {
  /**
   * Dead setting (#46): parsed and round-tripped, but nothing reads it — every date in the system is
   * computed in Asia/Taipei, hardcoded in core/time.ts. Kept (not deleted) because removing it would
   * change the settings schema and break the stored-settings round-trip env.test.ts asserts.
   * There is deliberately no admin UI field for it: an editable control that changes nothing is worse
   * than no control. Making the timezone real means changing core/time.ts, not this line.
   */
  timezone: string;
```

Add one line to `README.zh-TW.md` where settings are described: `` `timezone` 目前是死設定——時區固定為 Asia/Taipei（`core/time.ts`），改這個欄位沒有任何效果。``

- [ ] **Step 2: D21 — stop implying automatic role management**

`plans.discord_role_id` is only used to `@` a role in an announcement. `Manage.tsx`'s `PlanModal`:

```tsx
      <Field label="Discord 身分組 ID（僅用於通知時 @ 該身分組，不會自動發放或回收身分組）"><input value={f.discord_role_id} onChange={(e) => set("discord_role_id", e.target.value)} disabled={busy} /></Field>
```

- [ ] **Step 3: D16 — say which messages the template card actually covers**

Only three messages are editable (開繳通知／逾期催繳／常駐繳費訊息). Two are hardcoded in the worker:

```bash
git grep -n "還沒綁定的成員\|已將你加入" -- packages/worker/src
```

- the bind-button message content — in **`packages/worker/src/routes/admin.ts`**, `discordBindMessage` (not in `adapters/discord/notify.ts`, which only builds the button row)
- the new-member nudge — in **`packages/worker/src/adapters/discord/notify.ts`**, `sendPaymentNudge`

Unifying them is batch-E scope, so state the boundary instead of hiding it. `Settings.tsx`:

```tsx
      <Card title="Discord 訊息文字" desc="機器人在頻道發出的訊息（支援 Discord markdown，即時預覽）。綁定按鈕訊息與新成員提醒目前寫死在程式中，不在這裡編輯。">
```

And the same comment above each hardcoded `content` literal:

```ts
// Hardcoded on purpose for now (#46): unlike 開繳／催繳／常駐繳費訊息, this message has no
// workspace-settings template. 設定 → Discord 訊息文字 says so. Making it editable is a settings
// schema change (deferred with the rest of the 期別 lifecycle work).
```

- [ ] **Step 4: Gates**

```bash
pnpm -r typecheck
pnpm --filter @chippot/worker test 2>&1 | tail -6
```

Expected: PASS, count = baseline **+4** (unchanged from Task 11 — annotations add no tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src packages/admin/src README.zh-TW.md
git commit -m "docs(copy): 標註死設定 timezone、身分組不自動發放、寫死訊息不受模板控制 (#46)"
```

---

## Task 15: 全域殘留稽核、README、CI 閘門、PR

**Files:**
- Modify: `README.md`, `README.zh-TW.md` (test badge + any leftover the sweep surfaces)
- Modify (local only, **never `git add`**): `docs/deploy-state.md`

**Interfaces:**
- Consumes: Tasks 1–14.
- Produces: a PR closing #46, and an owner-facing note that Discord commands must be re-registered after deploy.

- [ ] **Step 1: Run every zero-hits assertion at once**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
for t in 核准 本期 開帳 支付渠道 使用者 帳單頻道 已退訂 開始繳費; do
  echo "── $t ──"
  git grep -n "$t" -- packages README.md README.zh-TW.md
done
```

Every section must be empty. A hit here means a task's sweep missed a site or a later task reintroduced the word — go fix it and amend that task's commit (or add a follow-up commit; do not ship a partial sweep).

- [ ] **Step 2: Run the judgement-call greps and check each hit against §A**

```bash
git grep -n "已繳" -- packages README.md README.zh-TW.md | grep -v "已繳待驗" | grep -v "已繳／已驗證"
git grep -n "月份" -- packages/admin
git grep -n "期別" -- packages/web packages/worker/src/adapters
git grep -n "無憑證" -- packages
```

Allowed, and nothing else:
- `已繳`: the `README.zh-TW.md` intro sentence `誰欠／已繳／已驗證`, which describes money rather than the status label.
- `月份` in admin: exactly the two CSV-import lines (§A.4).
- `期別` in web/adapters: **nothing**.
- `無憑證`: exactly the two identical `無憑證，純聲明 — 請依備註與帳戶自行核對。` sentences (§A.8).

- [ ] **Step 2b: Prove the two Discord command payloads still agree**

`scripts/register-commands.mjs` hand-duplicates `PAY_COMMAND` and `INITIATE_COMMAND` because a `.mjs` cannot import the TS module. Tasks 1 and 4 each edited both copies; confirm they did not drift:

```bash
for s in "登記繳費（一次涵蓋" "（管理員）確認指定期別"; do
  echo "── $s ──"
  git grep -h "$s" -- packages | sed 's/^ *//;s/^description: //' | sort -u
done
```

Each block must print exactly **one** distinct description string. Two lines means the `.ts` and the `.mjs` disagree, and `pnpm --filter @chippot/worker register` would push the wrong text to Discord.

- [ ] **Step 3: Full CI-parity gates, in CI's order**

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test 2>&1 | tail -8
pnpm -r build
```

`pnpm -r build` needs `VITE_API_BASE`; CI supplies a throwaway. Do the same:

```bash
VITE_API_BASE=https://example.invalid pnpm -r build
```

Then reproduce CI's fail-fast guard — the web build **must refuse** to build without it:

```bash
pnpm --filter @chippot/web build && echo "BROKEN: built without VITE_API_BASE" || echo "OK: refused, as intended"
```

Record the exact `Tests  N passed (N)` number. It should be the Task 1 baseline **+4**.

- [ ] **Step 4: Update the test badge in both READMEs**

Both files carry the same badge line and `README.zh-TW.md` repeats the count in prose:

```
![Vitest](https://img.shields.io/badge/tests-<N>%20passing-0f6e63?logo=vitest&logoColor=white)
```

and in `README.zh-TW.md`: `- 🧪 **真環境測試** — <N> 個 Vitest 案例跑在真正的 Miniflare D1 + R2…`

Use the N from Step 3, not an arithmetic guess.

- [ ] **Step 5: Push and open the PR**

```bash
git add README.md README.zh-TW.md
git commit -m "docs(readme): 測試徽章更新為 <N>,並同步術語統一後的按鈕名 (#46)"
git push -u origin ux/46-terminology
```

```bash
gh pr create --title "refactor(copy): 術語與文案統一（驗證／已繳待驗／繳費渠道／此期／開繳）" --body "$(cat <<'EOF'
Closes #46

UX 健檢批次 D。幾乎全字串;不動任何 DB 值、enum、custom_id 或 API 形狀。

## 正規用詞
- 動作＝**驗證**（刪除「核准」,含程式註解與測試標題）;狀態＝已驗證;流程／佇列＝審核
- `paid` 一律顯示 **已繳待驗**（表頭空間不足處用「待驗」）
- **繳費渠道**（完整名）＋ 渠道（表格短名）;刪除「支付渠道」
- **此期**／實際期別,刪除「本期」;**開繳**,刪除「開帳」
- 後台＝期別,成員面（Discord＋繳費頁）＝月份
- 成員（刪除唯一一處「使用者」）、純聲明（「無憑證」只留作解釋文字）

## 一併收掉批次 E 遺留的期別標籤
- D3 按鈕改「此期」;D5 開帳→開繳;D7 按鈕字面補成完整名 `重新同步此期帳單`,設定頁的指涉現在完全對得上

## 行為相鄰的改動（有測試）
- `routes/admin.ts` 可觸及的錯誤訊息改中文;純格式驗證（`period must be YYYY-MM` 等）**刻意保留英文**（UI 走不到）
- `InvalidPaymentTransition` 訊息改中文,`paymentId`／`to` 欄位保留給日誌
- 來源／訂閱狀態／供應商加中文顯示對映（**顯示層**,`<option value>` 與 DB 值不變）
- 繳費頁與方案金額補千分位

## 刻意不做
- `settings.timezone` 死設定：標註,不移除（移除會改 settings schema）
- 寫死訊息 vs 模板：標註邊界,不統一（屬期別生命週期重構範圍）
- 列內 編輯／刪除 不加「…」（每列重複,行動版卡片上是噪音）;只有工具列／卡片頭的開窗動作加

## ⚠️ 部署後必做
`/繳費` 與 `/發起繳費` 的**指令描述**有變更。Discord 的指令描述是註冊時寫死的,**部署後必須到
設定 → 工具 → 「註冊 Discord 指令」按一次**（或 `pnpm --filter @chippot/worker register`）,
否則成員在 Discord 看到的仍是舊描述（包含 #46 P0-8 那句錯的「可選」）。

Worker tests: <N> passed。typecheck / admin build / web build 皆綠。
EOF
)"
```

- [ ] **Step 6: Append the deploy-state entry — local only**

`docs/deploy-state.md` is gitignored. Append one section at the **very end** (newest last, matching `## 收回已開繳的月份 (PR #41 + 徽章 #42, 2026-07-29)`), replacing `NN` with the PR number:

```markdown
## 術語與文案統一 (PR #NN, 2026-07-31)
- issue #46（UX 健檢批次 D）。正規用詞：驗證（刪核准）／已繳待驗（刪已繳）／繳費渠道（刪支付渠道）／
  此期（刪本期）／開繳（刪開帳）／成員（刪使用者）；後台＝期別、成員面＝月份。
- 一併收掉原留給批次 E 的期別標籤三項（D3 按鈕、D5 開帳、D7 按鈕名與文案對齊）。
- 行為相鄰：後台可觸及錯誤訊息中文化（格式驗證維持英文）、狀態競態訊息中文化（欄位保留）、
  來源／訂閱狀態／供應商顯示層中文對映（DB 值不變）、繳費頁與方案金額千分位。
- 標註而非改造：`settings.timezone` 死設定、身分組不自動發放、寫死訊息不受模板控制。
- Worker tests **<N> passed**（baseline +4）；typecheck／admin build／web build 皆綠。
- ⚠️ **部署後必須重新註冊 Discord 指令**（設定 → 工具 → 註冊 Discord 指令）：`/繳費` 與 `/發起繳費`
  的描述有改，未重註冊的話成員看到的仍是舊描述。
- Deploy（main `<sha>`, 2026-07-31）: Worker Version `<id>` + Admin Pages `<url>` + Web Pages `<url>`
  （web 這次有動：頁面標題、月份、千分位、至少填一項）。
```

**Do not `git add` this file.** Every `git add` in this plan names explicit paths precisely so this cannot happen by accident.

- [ ] **Step 7: Tell the owner what needs a human**

The PR body already carries the re-registration warning, but say it in the handoff message too, because it is the one step no CI check will catch: **after merging and deploying, open 設定 → 工具 → 「註冊 Discord 指令」 and run it once.** Discord caches command descriptions from registration time; until that runs, members still see the old `/繳費` description — the exact P0 this batch set out to fix.

---

## Self-Review

**1. Spec coverage — issue #46, item by item.**

| Spec item | Task |
|---|---|
| P0-7 移除（訂閱已暫停／已取消） | Task 1 Step 3 |
| P0-8 `/繳費` 至少填一項 | Task 1 Step 4 |
| D1 核准→驗證 | Task 2 |
| D2 paid→已繳待驗 | Task 3 |
| D3 本期→實際期別／此期 | Task 4 (§A.3) |
| D4 期別 vs 月份 | Task 5 |
| D5 開帳→開繳 | Task 4 Step 4 + Task 9 Step 5 (`env.ts` default) |
| D6 帳單頻道→繳費頻道 | Task 7 Step 3 |
| D7 按鈕名與文案對齊 | Task 4 Steps 2, 4 |
| D8 支付渠道→繳費渠道 | Task 6 |
| D9 使用者備註→成員備註 | Task 7 Step 2 |
| D10 無憑證→純聲明 | Task 3 Step 3 + Task 7 Step 5 |
| D11 enum 中文化 | Task 8 |
| D12 `/繳費` 訊息的「本期」 | Task 4 Step 5 |
| D13 至少填一項 | Task 9 |
| D14 後台錯誤中文化 | Task 10 |
| D15 競態錯誤中文化 | Task 11 |
| D16 寫死 vs 模板（標註） | Task 14 Step 3 |
| D17 格式（括號／破折號／…／進度字） | 括號 in Tasks 3, 6; 破折號 in Task 4 Step 4; `…`＋進度字 in Task 13 |
| D18 前綴與分隔符 | Task 13 Steps 4, 5 (+ `admin.ts:665` in Task 2 Step 3) |
| D19 千分位 | Task 12 |
| D20 語氣（他／開始繳費／title／句末標點） | Task 7 Step 4, Task 9 Steps 4, 5 |
| D21 身分組不自動發放 | Task 14 Step 2 |
| D22 timezone 死設定（標註） | Task 14 Step 1 |
| 測試斷言與 README 同步 | folded into every sweep; final audit + badge in Task 15 |

**2. Placeholder scan.** `<N>` in Task 15 and `NN` in the deploy-state entry are *runtime-measured* values, each with the command that produces them named in the step immediately above — not TBDs. The baseline count is deliberately unspecified for the same reason: it depends on what A/B/C landed, and Task 1 Step 2 measures it. Every code step carries the actual code.

**3. Type consistency.** Two new identifiers, both defined once and referenced nowhere else: `SOURCE_LABEL` (`Record<string, string>`, `PaymentDetail.tsx`) and `SUB_STATUSES` / `SUB_STATUS_LABEL` (`Manage.tsx`, shaped exactly like the file's existing `CHANNEL_TYPES` / `CHANNEL_TYPE_LABEL`). No task references a symbol another task did not define. `InvalidPaymentTransition` keeps its constructor signature `(paymentId: number, to: PaymentStatus)`, so its three existing call sites and four test references compile unchanged.

**4. Two cross-batch hazards, both handled.** UX-A owns finding A5 (發起繳費's 「本期」) — Task 4 Step 1 tells the implementer to expect those hits to be already gone and to fix whatever survived. UX-C owns P0-6 (`routes/upload.ts` English errors on the member page) — §A.14 marks it explicitly out of scope so Task 10 does not widen into C's files.

**5. Verified against the tree on 2026-07-31** (pre-A/B/C, so counts will move — the shape will not). Route paths confirmed against `buildAdminRouter()`: there is no `GET /admin/users/:id`, and initiate is `POST /admin/billing/initiate` with the period in the body. The hardcoded bind-message content lives in `routes/admin.ts`'s `discordBindMessage`, not in `adapters/discord/notify.ts` (which holds the *other* hardcoded message, `sendPaymentNudge`). `pnpm --filter <pkg> run typecheck` verified working. `settings.timezone` confirmed to have three occurrences, all in `env.ts`, and no admin UI control. `no_proof_count` confirmed as `status IN ('paid','verified') AND has_proof = 0`, which is why §A.8's label names both states. **Two things the audit's file list missed and this plan adds:** `packages/worker/scripts/register-commands.mjs` duplicates both Discord command descriptions (so P0-8 would have shipped half-fixed and `pnpm register` would have undone it), and both READMEs repeat the 已退訂 inaccuracy in their 重新同步 bullet.
