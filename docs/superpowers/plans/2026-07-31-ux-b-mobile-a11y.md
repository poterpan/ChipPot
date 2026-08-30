# UX-B 行動版收尾與可及性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ChipPot admin surface usable on a phone and on iPad/landscape widths, and give the whole front end the keyboard, contrast and semantic basics it currently lacks — without touching the worker or the `--line` paper aesthetic.

**Architecture:** Three structural moves carry most of the batch. (1) The `.tbl-cards` card treatment is extended to the four Manage tables and the Dashboard push-status table by adding `data-label` to each `td` — no new CSS layout, the rules already exist. (2) The mobile breakpoint moves from 720px to **1000px** and the mobile page layout switches from CSS grid to normal block flow, which is what finally lets the tab strip be `position: sticky`. (3) Above 1000px, where tables stay tables, the row-identity column and the row-action column become `position: sticky` inside the `.tbl` scroller, so "the action button starts off-screen" stops being possible at *any* width instead of moving the dead zone up to 1346px. Everything else is small, independent CSS/TSX edits: one Modal component gains dialog semantics, focus trap, Escape and scroll lock; one contrast pass changes token *values* rather than 20 call sites; the rest are per-view fixes.

**Tech Stack:** React 18 + TypeScript + Vite (`packages/admin`, `packages/web`), hand-written CSS with custom properties. No test framework in either front-end package — verification is `tsc --noEmit` + `vite build` + Chrome DevTools Protocol probes reused from the audit harness.

## Global Constraints

- **Pure frontend.** `packages/worker` is not touched by any task. The worker test suite must stay green exactly as it is (`pnpm -r test`), not be extended.
- **No test framework exists in `packages/admin` or `packages/web`.** Every task's verification is: `pnpm --filter @chippot/admin typecheck` + `pnpm --filter @chippot/admin build` (and the `@chippot/web` equivalents where web files changed) **plus** a CDP probe run with before/after numbers quoted in the commit body or task report. Never claim a task done on typecheck alone.
- **Reuse the audit's CDP harness.** It lives at
  `/private/tmp/claude-503/-Users-poterpan-Documents-Coding-Project-chippot/7aef7eeb-ada7-4500-ae8d-64683f168a3a/scratchpad/` — referred to below as `$SCRATCH`. Files: `mob-lib.mjs` (driver + `ADMIN_STUB` / `WEB_STUB` fetch stubs + `MEASURE` / `A11Y` payloads), `probe-admin.mjs` (17 scenes × 375/720/1280), `probe-focus.mjs`, `probe-boundary.mjs`, `probe-web.mjs`, `contrast.mjs`. Do **not** copy them into the repo.
- **Never touch `wrangler.toml`** (it is `skip-worktree`'d locally and the committed copy holds placeholders).
- **`deploy-state` and any local deploy artefacts stay local**; never commit them.
- **Conventional commits, zh-TW subject lines are fine**, e.g. `fix(admin): Manage 四表行動版卡片化（補 data-label）`.
- **Branch:** `ux/44-mobile-a11y`. **One PR**, body ends with `Closes #44`.
- **Owner decision, binding:** the `--line` paper aesthetic is **kept**. Only `input` / `textarea` / `select` borders darken, to ≥3:1. Card, table and topbar borders keep `--line` unchanged.
- **Danger-colour work belongs to batch A (#43), not here.** Do not define `--danger`, do not change `--danger`→`--red`, do not restyle `.btn--danger`, do not touch `Manage.tsx:21`'s `var(--danger, #c0392b)`.

### Don't-break list (measured-good behaviour — every task must preserve it)

| # | Invariant | How it is checked |
|---|---|---|
| 1 | **Zero horizontal page overflow** across all 51 admin scene×width combos and the member page | `probe-admin.mjs` → every `m.pageOverflow.overflows === false` and `m.bleeders` empty |
| 2 | **Savebar clears content**: scrolled to the bottom of Settings at 375px the fixed bar covers only its own buttons | `probe-focus.mjs` → `settingsBottom.blockedAtBottom` is `[]` |
| 3 | **Bottom sheet is global, not payments-scoped** — every admin modal becomes a sheet below the breakpoint, `.modal__head` stays sticky, ✕ always reachable | `probe-admin.mjs` → `extra.backdrop.placeItems === "end stretch"` on every `*-modal` scene at 375 |
| 4 | **Member page safe area**: `viewport-fit=cover` + `env(safe-area-inset-bottom)` in `.wrap` | `probe-web.mjs`; do not edit `packages/web/src/index.html`'s viewport meta |
| 5 | **MemberReview touch sizes**: bulk 347×46, per-row 核准 162×40 / 退回 143×40, reject input on the same row as 確認退回 | `probe-focus.mjs` → `memberReview`, `memberReviewReject.sameRow === true` |
| 6 | **`.stat__value` container-query clamp** — 7-digit 應收總額 does not overflow at 375px | `probe-admin.mjs` dashboard@375 → no bleeder matching `.stat__value` |

### ⚠️ REBASE-SENSITIVE tasks

Batch A (#43) is in flight and rewrites `Dashboard.tsx` (the 重置 / 立即重發 buttons gain preview+confirm modals), `Settings.tsx` (發起繳費 modal), part of the `Payments.tsx` toolbar copy, and consolidates danger styling. Tasks **12 (B9 toolbar)** and **13 (B10 Dashboard)** are marked ⚠️ and are written **against intent, not against line numbers**. Their implementer must: rebase onto post-A `main` first, re-locate the anchors by searching for the described elements, and satisfy the stated acceptance numbers whatever the buttons ended up being called.

### Why one PR, not two

The B-版面 / B-a11y split was considered and rejected: 17 of the 19 tasks edit `packages/admin/src/styles.css`, a single 300-line file, and several edit the *same rules* (`.field input…` carries both the 16px change and the darker border; the `≤breakpoint` block carries the card rules, the tap targets and the sheet button widths). Two PRs would spend more effort on conflict resolution than on the work. The breakpoint change (Task 3) is also a global regression risk that everything downstream has to be re-verified against — doing that verification twice doubles the cost for no reviewer benefit. Tasks still commit individually, so review remains task-by-task inside the one PR.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `packages/admin/src/styles.css` | All admin styling: tokens, breakpoint blocks, card treatment, sticky columns, focus rings, scroll shadows | 2,3,4,5,6,7,8,10,11,12,14,15,17 |
| `packages/admin/src/ui.tsx` | Shared primitives: `Modal` (dialog semantics/trap/lock), `Field`, `Card`, `Stat`, new `FilterSelect`, new `ErrorNote`, `.sr-only` consumers | 6,9,14,15 |
| `packages/admin/src/App.tsx` | Shell: tab strip scroll-into-view, `<header>` landmark | 5,9 |
| `packages/admin/src/views/Manage.tsx` | Four CRUD tables: `data-label`s, `.tbl--pin-*` classes, table captions, filter inputs, subscription form input types | 2,4,9,14,16 |
| `packages/admin/src/views/Payments.tsx` | Payments list: toolbar density, row keyboard operability, pin classes, caption, error retry | 4,9,10,12,15 |
| `packages/admin/src/views/Dashboard.tsx` | ⚠️ Push-status card-ification, plan-table pinning, captions | 4,9,13 |
| `packages/admin/src/views/Settings.tsx` | Accessible names for the three bare inputs, `--muted` inline sweep, `.btn--sm` removal, error retry | 7,9,15,18 |
| `packages/admin/src/views/MemberReview.tsx` | `完整資訊` tap target only (CSS-side) | 11 |
| `packages/web/src/styles.css` | Member page: `.field`/`select` rules that never existed, 16px, darker field border, contrast token, dead `.plans*` removal | 1(baseline),7,8,17,18 |
| `packages/web/src/App.tsx` | Member page: headings, `.note` accessible name, dead branch | 9 |
| `$SCRATCH/ux44/` (not in repo) | Per-task probe scripts and before/after JSON | all |

---

## Task 1: Verification harness, baseline capture, branch

**Files:**
- Create: `$SCRATCH/ux44/` (outside the repo — never committed)
- Create: `$SCRATCH/ux44/baseline/*.json`
- Modify: none

**Interfaces:**
- Produces: the baseline numbers every later task compares against, and the two dev-server ports the probes hard-code — **admin on 5461, web on 5462**. `probe-admin.mjs` and `probe-focus.mjs` read `http://localhost:5461`; `probe-web.mjs` reads `http://localhost:5462`. Do not change the ports; start the servers on them.
- Produces: `$SCRATCH/ux44/run.sh`, the one command later tasks call to re-probe.

- [ ] **Step 1: Create the branch off current `main`**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git checkout main && git pull --ff-only
git checkout -b ux/44-mobile-a11y
```

- [ ] **Step 2: Confirm the harness is where the plan says it is**

```bash
export SCRATCH=/private/tmp/claude-503/-Users-poterpan-Documents-Coding-Project-chippot/7aef7eeb-ada7-4500-ae8d-64683f168a3a/scratchpad
ls -1 "$SCRATCH"/{mob-lib.mjs,probe-admin.mjs,probe-focus.mjs,probe-boundary.mjs,probe-web.mjs,contrast.mjs}
mkdir -p "$SCRATCH/ux44/baseline"
```

**Every task below assumes `$SCRATCH` is exported.** If a shell does not persist between tool calls, re-export it as the first line of each bash block — the scripts hard-code nothing else.

Expected: all six files listed. If any is missing, stop and report — the whole plan's verification story depends on them. (`mob-lib.mjs` exports `launch()`, `sleep()`, `ADMIN_STUB`, `WEB_STUB`, `MEASURE`, `A11Y`; it drives headless Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` over CDP with `window.fetch` stubbed to 9 members / 3 plans / 3 channels / 9 mixed-status payments.)

- [ ] **Step 3: Write the server and probe runners**

Two scripts, deliberately separate: the dev servers stay up for the whole batch (Vite HMR picks up each task's edits, so no rebuild between probes), and every per-task `.mjs` in later tasks assumes they are already listening.

Create `$SCRATCH/ux44/serve.sh`:

```bash
#!/bin/bash
# Starts the two dev servers detached on the ports the probes hard-code, and waits for them.
# Idempotent: if a port already answers, that server is left alone.
set -uo pipefail
SCRATCH=/private/tmp/claude-503/-Users-poterpan-Documents-Coding-Project-chippot/7aef7eeb-ada7-4500-ae8d-64683f168a3a/scratchpad
REPO=/Users/poterpan/Documents/Coding/Project/chippot
mkdir -p "$SCRATCH/ux44"
cd "$REPO" || exit 1

curl -sf http://localhost:5461 >/dev/null \
  || nohup pnpm --filter @chippot/admin dev -- --port 5461 --strictPort >"$SCRATCH/ux44/dev-admin.log" 2>&1 &
curl -sf http://localhost:5462 >/dev/null \
  || nohup pnpm --filter @chippot/web dev -- --port 5462 --strictPort >"$SCRATCH/ux44/dev-web.log" 2>&1 &

for i in $(seq 1 60); do
  curl -sf http://localhost:5461 >/dev/null && curl -sf http://localhost:5462 >/dev/null && { echo "servers up"; exit 0; }
  sleep 1
done
echo "servers did not come up — check $SCRATCH/ux44/dev-*.log"; exit 1
```

Create `$SCRATCH/ux44/run.sh`:

```bash
#!/bin/bash
# usage: run.sh <label>   → $SCRATCH/ux44/<label>/{admin,focus,boundary,web}.json + contrast.txt
# Leaves the dev servers running so the per-task probe scripts can follow.
set -uo pipefail
SCRATCH=/private/tmp/claude-503/-Users-poterpan-Documents-Coding-Project-chippot/7aef7eeb-ada7-4500-ae8d-64683f168a3a/scratchpad
LABEL="${1:?label required}"
OUT="$SCRATCH/ux44/$LABEL"; mkdir -p "$OUT"
"$SCRATCH/ux44/serve.sh" || exit 1

node "$SCRATCH/probe-admin.mjs"    > "$OUT/admin.json"
node "$SCRATCH/probe-focus.mjs"    > "$OUT/focus.json"
node "$SCRATCH/probe-boundary.mjs" > "$OUT/boundary.json"
node "$SCRATCH/probe-web.mjs"      > "$OUT/web.json"
node "$SCRATCH/contrast.mjs"       > "$OUT/contrast.txt"
echo "wrote $OUT"
```

Create `$SCRATCH/ux44/stop.sh` for the end of the batch:

```bash
#!/bin/bash
pkill -f "vite.*--port 546[12]" || true
echo "dev servers stopped"
```

```bash
chmod +x "$SCRATCH/ux44/"{serve,run,stop}.sh
```

`run.sh` starts the servers itself if they are down, so a later task can be picked up cold. `probe-admin.mjs` reads `http://localhost:5461`; `probe-web.mjs` reads `http://localhost:5462`; do not change the ports.

- [ ] **Step 4: Capture the baseline**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && "$SCRATCH/ux44/run.sh" baseline
```

- [ ] **Step 5: Record the numbers this batch must move**

```bash
OUT=$SCRATCH/ux44/baseline
OUT="$OUT" node -e '
const a=require(process.env.OUT+"/admin.json");
const f=require(process.env.OUT+"/focus.json");
const b=require(process.env.OUT+"/boundary.json");
const over=Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k);
console.log("scenes:",Object.keys(a).length,"| horizontal overflow:",over.length,over);
for (const v of ["users","subscriptions","plans","tags"])
  console.log(v.padEnd(14), "actions off-screen@375:", f["actions_"+v].offscreenCount+"/"+f["actions_"+v].n,
              "tblHidden:", f["actions_"+v].tblHidden);
console.log("721-932 dead zone:", JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k])=>/^\d+$/.test(k)).map(([w,v])=>[w,v.payments.rowActionsOffscreen]))));
console.log("toolbar@375:", f.paymentsToolbar.toolbarH+"px, first card y="+f.paymentsToolbar.firstCardTop+", rows above fold "+f.paymentsToolbar.rowsAboveFold);
console.log("modal:", JSON.stringify(a["users+edit-modal@375"].a.dialog));
console.log("escape closes:", f.modalOpenAfterEscape===false, "| body lock:", f.bodyLock.bodyOverflow);
console.log("savebar blocked:", JSON.stringify(f.settingsBottom.blockedAtBottom));
' | tee "$OUT/summary.txt"
grep -c "FAIL" "$OUT/contrast.txt"
```

Expected (this is the "before" the PR body must quote): 51 scenes, 0 horizontal overflow, `users 18/18 subscriptions 18/18 plans 6/6 tags 9/9`, dead zone `4/4` at 721/768/844/932, toolbar 183px with first card at y=330 and 2 rows above the fold, `dialog.role === null`, escape-closes `false`, `bodyOverflow "visible"`, savebar blocked `[]`, 15 contrast FAILs.

- [ ] **Step 6: Confirm the worker suite is green before any change**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && pnpm -r test
```

Expected: PASS (243 tests). This is the number Task 19 re-checks; no task in this plan may change it.

- [ ] **Step 7: Commit the branch point (empty marker so the PR has a base)**

No repo files changed yet — skip the commit and go to Task 2. (Recorded here so an implementer reading only this task does not invent a commit.)

---

## Task 2: P0-9 — Manage 四表 stack into cards at ≤720px

**Files:**
- Modify: `packages/admin/src/views/Manage.tsx` (four `<table>` elements at `:36`, `:112`, `:206`, `:295` and their `<td>`s)
- Modify: `packages/admin/src/styles.css` (the `.tbl-cards td:last-child` rules at `:286-288`)

**Interfaces:**
- Consumes: the existing `.tbl-cards` block at `styles.css:263-301` — no new layout rules needed, the card shape is already defined and proven on Payments.
- Produces: all four Manage tables carry `className="tbl-cards"`, every non-action `<td>` carries a `data-label`, and the action `<td>` renders 2–3 side-by-side thumb-sized buttons instead of one full-width one. Task 4 adds `.tbl--pin-*` to the same wrappers; Task 9 adds `<caption>`; Task 14 adds filter inputs.

**Why the breakpoint is still 720 in this task:** keeping the breakpoint move in its own commit (Task 3) means that if the card-ification regresses something, the two changes can be bisected apart.

- [ ] **Step 1: Let a card's action cell hold more than one button**

Payments' action cell has exactly one button and gets `width: 100%`. Manage's has two (編輯/刪除) or three (停用/編輯/刪除). Because `.tbl-cards td` is already `display: flex`, giving every button `width: 100%` makes them shrink to equal shares automatically — the only thing to fix is the inherited 12px gap and the `space-between` alignment.

In `packages/admin/src/styles.css`, replace lines 286-288:

```css
  /* the trailing action cell gets one full-width, thumb-sized button */
  .tbl-cards td:last-child { padding-top: 9px; }
  .tbl-cards td:last-child .btn { width: 100%; min-height: 42px; justify-content: center; }
```

with:

```css
  /* the trailing action cell: one full-width button, or 2–3 equal thumb-sized ones.
     width:100% on every child + the cell's own flex shrink = equal shares, no per-count rules. */
  .tbl-cards td:last-child { padding-top: 9px; gap: 8px; }
  .tbl-cards td:last-child .btn { width: 100%; min-height: 42px; justify-content: center; }
```

- [ ] **Step 2: Card-ify 成員** — `Manage.tsx:36-50`

```tsx
          <table className="tbl-cards">
            <thead><tr><th>名稱</th><th>Discord ID</th><th>Email</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4}><Empty>載入中…</Empty></td></tr>}
              {data?.users.map((u) => (
                <tr key={u.id}>
                  <td data-label="名稱">{u.display_name}</td>
                  <td data-label="Discord ID" className="mono" style={{ fontSize: 12.5 }}>{u.discord_id ?? "—"}</td>
                  <td data-label="Email">{u.email ?? "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(u)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(u)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

(The first cell's `data-label` is intentionally present but never rendered — `.tbl-cards td:first-child::before { display: none }` at `styles.css:283` suppresses it. Payments already does this; keeping the pattern uniform stops the next editor from wondering which cells need one.)

- [ ] **Step 3: Card-ify 訂閱** — `Manage.tsx:112-126`

```tsx
          <table className="tbl-cards">
            <thead><tr><th>成員</th><th>方案</th><th>狀態</th><th>起算日</th><th className="right">結帳日</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {data?.subscriptions.map((s) => (
                <tr key={s.id}>
                  <td data-label="成員">{s.user_name}</td>
                  <td data-label="方案">{s.plan_name}</td>
                  <td data-label="狀態">{s.status}</td>
                  <td data-label="起算日" className="mono">{s.start_date}</td>
                  <td data-label="結帳日" className="right mono">{s.billing_day}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(s)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(s)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

- [ ] **Step 4: Card-ify 方案** — `Manage.tsx:206-220`

```tsx
          <table className="tbl-cards">
            <thead><tr><th>名稱</th><th>provider</th><th className="right">月費</th><th>身分組 ID</th><th>啟用</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {shown.map((p) => (
                <tr key={p.id}>
                  <td data-label="名稱">{p.name}</td>
                  <td data-label="provider">{p.provider}</td>
                  <td data-label="月費" className="right mono">NT${p.monthly_amount}</td>
                  <td data-label="身分組 ID" className="mono" style={{ fontSize: 12 }}>{p.discord_role_id ?? "—"}</td>
                  <td data-label="啟用">{p.active ? "✓" : "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(p)}>編輯</button>{" "}
                    <button className="btn" disabled={(p.subscription_count ?? 0) > 0} title={(p.subscription_count ?? 0) > 0 ? "使用中，請先刪除訂閱或停用" : ""} onClick={() => setDel(p)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

- [ ] **Step 5: Card-ify 支付渠道** — `Manage.tsx:295-316`

```tsx
          <table className="tbl-cards">
            <thead><tr><th>名稱</th><th>類型</th><th className="right">排序</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><Empty>載入中…</Empty></td></tr>}
              {data?.channel_tags.map((t) => (
                // Disabled channels dim the whole row so it's obvious at a glance which are off.
                <tr key={t.id} style={t.active ? undefined : { color: "var(--muted)" }}>
                  <td data-label="名稱">{t.name}</td>
                  <td data-label="類型">{t.type ? (CHANNEL_TYPE_LABEL[t.type] ?? t.type) : "—"}</td>
                  <td data-label="排序" className="right mono">{t.sort_order}</td>
                  <td data-label="狀態">
                    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, whiteSpace: "nowrap", ...(t.active ? { color: "var(--teal-ink)" } : { background: "#efe8da", color: "#8a7d63" }) }}>
                      {t.active ? "啟用中" : "已停用"}
                    </span>
                  </td>
                  <td className="right">
                    <button className="btn" disabled={busyId === t.id} onClick={() => toggleActive(t)}>{t.active ? "停用" : "啟用"}</button>{" "}
                    <button className="btn" onClick={() => setEdit(t)}>編輯</button>{" "}
                    <button className="btn" disabled={(t.usage_count ?? 0) > 0} title={(t.usage_count ?? 0) > 0 ? "已被繳費紀錄參照，請改用停用" : ""} onClick={() => setDel(t)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

- [ ] **Step 6: Typecheck and build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

Expected: both succeed, no TS errors.

- [ ] **Step 7: Probe — the P0-9 numbers must go to zero**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && "$SCRATCH/ux44/run.sh" t02
O="$SCRATCH/ux44/t02" node -e '
const f=require(process.env.O+"/focus.json"), a=require(process.env.O+"/admin.json");
for (const v of ["users","subscriptions","plans","tags"])
  console.log(v.padEnd(14), f["actions_"+v].offscreenCount+"/"+f["actions_"+v].n, "| sample:", JSON.stringify(f["actions_"+v].sample.slice(0,2)));
console.log("overflow scenes:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
console.log("sub-24px targets @375:", Object.entries(a).filter(([k])=>/@375$/.test(k)).flatMap(([k,v])=>(v.m?v.m.taps:[]).map(t=>k+" "+t.txt+" "+t.w+"x"+t.h)));
'
```

Expected: `users 0/18`, `subscriptions 0/18`, `plans 0/6`, `tags 0/9`; overflow scenes `[]` (don't-break #1); no new sub-24px targets on the Manage views (the three-button 渠道 cell should measure roughly 106×42 each at 375px).

- [ ] **Step 8: Commit**

```bash
git add packages/admin/src/views/Manage.tsx packages/admin/src/styles.css
git commit -m "fix(admin): Manage 四表行動版卡片化（補 data-label），列動作不再從畫面外開始

P0-9：成員 18/18、訂閱 18/18、方案 6/6、渠道 9/9 顆按鈕的 left >= innerWidth
→ 全部 0/N。動作格改為 2-3 顆等寬 42px 按鈕（沿用既有 .tbl-cards 規則）。"
```

---

## Task 3: P0-10 — mobile breakpoint 720px → 1000px, mobile layout to block flow

**Files:**
- Modify: `packages/admin/src/styles.css` — four media blocks: `:145` (layout), `:218` (settings/savebar), `:253` (`min-width: 721px` mrow), `:263` (cards + sheet)

**Interfaces:**
- Consumes: Task 2's card-ified Manage tables (so raising the breakpoint helps them too).
- Produces: **the batch-wide breakpoint constant is 1000px** — `@media (max-width: 1000px)` for mobile, `@media (min-width: 1001px)` for desktop. Every later task that adds a responsive rule uses these exact values. Also produces `.app { display: block }` below the breakpoint, which is the precondition Task 5 needs for a sticky tab strip.

**Why 1000 and not "content-width-driven":** container queries were evaluated. They would need a *different* threshold per table (the Manage tables need 631–813px, the 8-column payments table needs 1058px), so a single container threshold would either leave the payments table broken or turn payments into cards on a 1440px desktop. A per-table threshold class is more machinery than the problem deserves. 1000px covers every real device in the dead zone (iPad portrait 768/820, landscape phones 844/932) and the residual "table too wide for the column" case above 1000px is solved properly in Task 4 by pinning the identity and action columns, which works at *every* width instead of moving the dead zone up to ~1346px.

- [ ] **Step 1: Document the constant at the top of the mobile section**

Replace lines 145-149 of `packages/admin/src/styles.css`:

```css
@media (max-width: 720px) {
  /* rows: nav bar sizes to its content (no stretch); main absorbs the remaining height.
     Without `auto 1fr`, grid's default align-content:stretch splits spare vertical space
     across both rows and visibly inflates the nav bar on short pages. */
  .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; height: auto; min-height: 100vh; }
```

with:

```css
/* ── MOBILE BREAKPOINT = 1000px ───────────────────────────────────────────────
   Raised from 720px (issue #44 / P0-10): between 721 and 932px the desktop layout
   snapped back — 232px sidebar plus a 489–700px content column — so the row-action
   buttons of an 8-column table started off-screen on exactly iPad portrait (768/820)
   and landscape phones (844/932). Four blocks in this file use it:
     @media (max-width: 1000px)  — this one (shell), the settings/savebar block,
                                    the .tbl-cards + bottom-sheet block
     @media (min-width: 1001px)  — the .mrow two-column block, the sticky-column block
   Change all of them together or the layout desynchronises. Above 1000px, wide tables
   stay tables and keep their actions reachable via the sticky columns instead.
   ───────────────────────────────────────────────────────────────────────────── */
@media (max-width: 1000px) {
  /* Block flow, not grid: a sticky grid item is confined to its own grid area, which for a
     single-row track is exactly its own box — i.e. `position: sticky` on .sidebar would be a
     no-op. Plain block flow makes the document the sticky containing block (see .sidebar below)
     and also removes the old align-content:stretch problem that `auto 1fr` was working around. */
  .app { display: block; height: auto; min-height: 100vh; }
```

- [ ] **Step 2: Move the other three media queries**

In the same file:
- `:218` `@media (max-width: 720px) {` → `@media (max-width: 1000px) {` (the `.settings` / `.savebar` block)
- `:253` `@media (min-width: 721px) {` → `@media (min-width: 1001px) {` (the `.mrow` two-column block)
- `:263` `@media (max-width: 720px) {` → `@media (max-width: 1000px) {` (the `.tbl-cards` + bottom-sheet block)

Leave every declaration inside them unchanged.

- [ ] **Step 3: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

- [ ] **Step 4: Probe the dead zone and the three don't-break invariants**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && "$SCRATCH/ux44/run.sh" t03
O="$SCRATCH/ux44/t03" node -e '
const b=require(process.env.O+"/boundary.json"), a=require(process.env.O+"/admin.json"), f=require(process.env.O+"/focus.json");
for (const w of [721,768,844,932]) console.log(w, "payments", b[w].payments.rowActionsOffscreen,
  "| subs", b[w].subscriptions.rowActionsOffscreen, "| tableDisplay", b[w].payments.tableDisplay, "| sidebarW", b[w].payments.sidebarW);
console.log("overflow scenes:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
console.log("bleeders:", Object.entries(a).filter(([k,v])=>v.m&&v.m.bleeders.length).map(([k,v])=>k+":"+v.m.bleeders.length));
console.log("savebar blocked:", JSON.stringify(f.settingsBottom.blockedAtBottom), "pad", f.settingsBottom.settingsPadBottom);
console.log("sheet@375:", JSON.stringify(a["users+edit-modal@375"].extra.backdrop));
console.log("sheet@720:", JSON.stringify(a["users+edit-modal@720"].extra.backdrop));
'
```

Expected: all four widths report `0/N` for payments **and** subscriptions, `tableDisplay: "block"`, `sidebarW` ≈ full viewport width (the strip, not the 232px rail); overflow scenes `[]`; bleeders none; savebar blocked `[]` (don't-break #2); backdrop `place-items: end stretch` at 375 and 720 (don't-break #3).

- [ ] **Step 5: Probe 1024 and 1280 — the widths the breakpoint change hands back to the table layout**

Create `$SCRATCH/ux44/wide.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const ORIGIN = "http://localhost:5461";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
const go = async (h, ready) => {
  await send("Page.navigate", { url: `${ORIGIN}/?r=${Date.now()}${Math.random()}#${h}` });
  for (let i = 0; i < 70; i++) { await sleep(150); try { if (await ev(`!!document.querySelector(${JSON.stringify(ready)})`)) return true; } catch {} }
  return false;
};
const R = {};
for (const w of [1024, 1280, 1440]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 820, deviceScaleFactor: 1, mobile: false });
  R[w] = {};
  for (const [v, ready] of [["payments", ".tbl-cards tbody tr"], ["users", "table tbody tr"], ["dashboard", ".stats"]]) {
    await go(v, ready); await sleep(400);
    R[w][v] = await ev(`(() => {
      const W = window.innerWidth, de = document.documentElement;
      const t = document.querySelector(".card .tbl");
      const btns = [...document.querySelectorAll(".card table tbody .btn")];
      const off = btns.filter(b => { const r = b.getBoundingClientRect(); return r.left >= W - 2 || r.right > W + 1; });
      const firstCells = [...document.querySelectorAll(".card table tbody tr td:first-child")].slice(0, 3)
        .map(td => ({ pos: getComputedStyle(td).position, left: Math.round(td.getBoundingClientRect().left) }));
      return { pageOverflow: de.scrollWidth > de.clientWidth + 1,
        tblHidden: t ? t.scrollWidth - t.clientWidth : null,
        actionsClipped: off.length + "/" + btns.length,
        firstCells };
    })()`);
  }
}
console.log(JSON.stringify(R, null, 1));
process.exit(0);
```

Run it while the dev servers from `run.sh` are up (or start admin on 5461 manually), and record the output as `$SCRATCH/ux44/t03/wide.json`.

Expected **at this task**: `pageOverflow: false` everywhere, but `payments.actionsClipped` is still `4/4` at 1024 and 1280 and `tblHidden` ≈ 322 / 68. **That is the known gap Task 4 closes** — record the numbers, do not treat them as a failure of this task.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/styles.css
git commit -m "fix(admin): 行動版斷點 720px → 1000px，行動版改用 block flow

P0-10：721/768/844/932（iPad 直立、手機橫放）四個寬度的列動作
payments 4/4、訂閱 18/18 在畫面外 → 全部 0/N。
行動版 .app 由 grid 改為 block，讓後續的 sticky 分頁條（B3）成立。
1024/1280 桌機寬度的表格外溢由下一個 commit 的 sticky 欄處理。"
```

---

## Task 4: Sticky identity + action columns and scroll-edge shadows (closes P0-10 above 1000px, B15, B19)

**Files:**
- Modify: `packages/admin/src/styles.css` — `table` rule at `:81`, `.tbl` at `:80`, `.content` at `:63`, new `@media (min-width: 1001px)` block
- Modify: `packages/admin/src/views/Payments.tsx:128`, `packages/admin/src/views/Manage.tsx:35,111,205,294`, `packages/admin/src/views/Dashboard.tsx:71`

**Interfaces:**
- Consumes: the 1000px constant from Task 3.
- Produces: two opt-in wrapper classes used by later tasks —
  - `.tbl--pin-first` → the first column of that table is `position: sticky; left: 0` above 1000px (keeps the row's name visible while scrolling right)
  - `.tbl--pin-last` → the last column is `position: sticky; right: 0` above 1000px (keeps the row's actions reachable)
  Both are no-ops below 1000px, where the same tables are cards.
- Produces: `table { border-collapse: separate; border-spacing: 0 }` — the prerequisite for reliable sticky table cells. This is visually identical here because only `border-bottom` is ever set on `th`/`td`, so no adjacent borders double up.

- [ ] **Step 1: Switch the table border model**

`packages/admin/src/styles.css:81`:

```css
table { width: 100%; border-collapse: collapse; font-size: 14px; }
```

→

```css
/* separate + zero spacing (not collapse): with collapsed borders the border belongs to the table,
   not the cell, so a `position: sticky` cell paints without its divider in WebKit. Visually
   identical here — only `border-bottom` is ever set, so nothing doubles up. */
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; }
```

- [ ] **Step 2: Give `.tbl` a scroll-edge shadow (B15, first half)**

`packages/admin/src/styles.css:79-80`:

```css
/* horizontal scroll container so wide tables never get clipped by the card on narrow screens */
.tbl { overflow-x: auto; -webkit-overflow-scrolling: touch; }
```

→

```css
/* horizontal scroll container so wide tables never get clipped by the card on narrow screens.
   The four background layers are the classic scroll-shadow: the two `local` gradients scroll with
   the content and cover the shadow when you reach an end, the two `scroll` gradients stay put.
   Pure CSS — it appears only when the table actually overflows and disappears at both ends. */
.tbl {
  overflow-x: auto; -webkit-overflow-scrolling: touch;
  background-color: var(--panel);
  background-image:
    linear-gradient(to right, var(--panel) 40%, rgba(255,255,255,0)),
    linear-gradient(to left, var(--panel) 40%, rgba(255,255,255,0)),
    radial-gradient(farthest-side at 0 50%, rgba(31,28,23,.14), rgba(31,28,23,0)),
    radial-gradient(farthest-side at 100% 50%, rgba(31,28,23,.14), rgba(31,28,23,0));
  background-repeat: no-repeat;
  background-position: left center, right center, left center, right center;
  background-size: 30px 100%, 30px 100%, 12px 100%, 12px 100%;
  background-attachment: local, local, scroll, scroll;
}
```

- [ ] **Step 3: Add the sticky-column block**

Append immediately after the `.tbl` rule (before the `th` rule) in `packages/admin/src/styles.css`:

```css
/* ── ≥1001px: wide tables keep their identity and their actions on screen ─────
   The 8-column payments table is 1058px wide; .content caps at 1180px minus 56px of padding,
   so below a ~1350px viewport it scrolls sideways no matter what. Pinning the first cell (who
   the row is about) and the last cell (what you can do to it) makes that scroll harmless instead
   of hiding the only two things that matter. Opt-in per table so a 3-column table isn't pinned
   for no reason. Below 1000px these tables are cards and the rules do not apply. */
@media (min-width: 1001px) {
  .tbl--pin-first th:first-child,
  .tbl--pin-first td:first-child {
    position: sticky; left: 0; z-index: 1;
    background: var(--panel); box-shadow: 1px 0 0 var(--line);
  }
  .tbl--pin-last th:last-child,
  .tbl--pin-last td:last-child {
    position: sticky; right: 0; z-index: 1;
    background: var(--panel); box-shadow: -1px 0 0 var(--line);
  }
  /* the sticky cells are opaque, so the row-hover tint has to be repainted on them */
  .tbl--pin-first tbody tr.click:hover td:first-child,
  .tbl--pin-last tbody tr.click:hover td:last-child { background: #faf7f0; }
}
```

- [ ] **Step 4: Widen the content column (B19)**

`packages/admin/src/styles.css:63`:

```css
.content { padding: 24px 28px 60px; max-width: 1100px; }
```

→

```css
/* 1180 (was 1100): minus 2×28px padding and the card's 1px borders this leaves 1122px, enough for
   the 8-column payments table's 1058px on a 1440px display. Narrower displays still scroll the
   table sideways — that is what the sticky columns above are for. */
.content { padding: 24px 28px 60px; max-width: 1180px; }
```

- [ ] **Step 5: Opt the six tables in**

- `packages/admin/src/views/Payments.tsx:128` — `<div className="tbl">` → `<div className="tbl tbl--pin-first tbl--pin-last">`
- `packages/admin/src/views/Manage.tsx:35` (成員), `:111` (訂閱), `:205` (方案), `:294` (渠道) — each `<div className="tbl">` → `<div className="tbl tbl--pin-first tbl--pin-last">`
- `packages/admin/src/views/Dashboard.tsx:71` (各方案, 7 numeric columns) — `<div className="tbl">` → `<div className="tbl tbl--pin-first">`

Leave `Dashboard.tsx:27` (推播狀態) and `:97` (依渠道) alone — `:27` is handled by Task 13, `:97` is three columns and never scrolls.

- [ ] **Step 6: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

- [ ] **Step 7: Probe — the 1024/1280 gap from Task 3 must close**

```bash
"$SCRATCH/ux44/run.sh" t04
# with the dev server still up:
node "$SCRATCH/ux44/wide.mjs" > "$SCRATCH/ux44/t04/wide.json"
O="$SCRATCH/ux44/t04" node -e '
const w=require(process.env.O+"/wide.json"), a=require(process.env.O+"/admin.json"), f=require(process.env.O+"/focus.json");
for (const px of ["1024","1280","1440"])
  console.log(px, "payments actions", w[px].payments.actionsClipped, "tblHidden", w[px].payments.tblHidden,
    "| firstCell pos", w[px].payments.firstCells[0].pos, "| users actions", w[px].users.actionsClipped,
    "| dashboard firstCell", w[px].dashboard.firstCells[0].pos, "| pageOverflow", w[px].payments.pageOverflow);
console.log("overflow scenes:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
console.log("savebar blocked:", JSON.stringify(f.settingsBottom.blockedAtBottom));
'
```

Expected: `payments actions 0/4` at 1024, 1280 **and** 1440; `firstCells[0].pos === "sticky"` on payments/users/dashboard at all three; `pageOverflow: false` everywhere; `tblHidden` 0 at 1440 (the max-width bump) and >0 at 1024/1280 (harmless, pinned); overflow scenes `[]`; savebar blocked `[]`.

- [ ] **Step 8: Eyeball the shadow and the pinned dividers**

Create `$SCRATCH/ux44/shot-pinned.mjs` (all probe scripts live in `ux44/` and import the driver as `../mob-lib.mjs` — never `node -e`, which cannot take top-level `await` without extra flags):

```js
import { writeFileSync } from "node:fs";
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "http://localhost:5461/#payments" });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".tbl-cards tbody tr")`)) break; }
await sleep(500);
await ev(`document.querySelector(".tbl").scrollLeft = 400`);
await sleep(300);
const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(new URL("./t04/payments-1280-scrolled.png", import.meta.url), Buffer.from(data, "base64"));
process.exit(0);
```

```bash
node "$SCRATCH/ux44/shot-pinned.mjs"
```

Open the PNG. Expected: 成員 pinned at the left with a hairline divider, 驗證 pinned at the right with a hairline divider, both readable, no content bleeding under them.

- [ ] **Step 9: Commit**

```bash
git add packages/admin/src/styles.css packages/admin/src/views/Payments.tsx packages/admin/src/views/Manage.tsx packages/admin/src/views/Dashboard.tsx
git commit -m "feat(admin): 寬表格首欄與動作欄 sticky ＋ 橫向捲動邊緣陰影

closes P0-10 的桌機側（1024/1280 的 驗證 4/4 在畫面外 → 0/4）、B15（.tbl 邊緣提示）、
B19（.content max-width 1100 → 1180，1440px 不再需要橫捲）。
table 改 border-collapse: separate 以讓 sticky cell 正常畫出分隔線。"
```

---

## Task 5: B3 — mobile tab strip becomes sticky, scrolls the active tab into view, gets an edge fade

**Files:**
- Modify: `packages/admin/src/styles.css` — `.sidebar` inside the `≤1000px` block at `:151`, `.topbar` at `:158`
- Modify: `packages/admin/src/App.tsx` — the `<nav className="nav">` at `:61-67`

**Interfaces:**
- Consumes: `.app { display: block }` from Task 3 (without it `position: sticky` on `.sidebar` is a no-op).
- Produces: `.nav` gains a `ref`; no exported API change.

- [ ] **Step 1: Make the strip sticky and stop the topbar competing for the top edge**

Inside the `@media (max-width: 1000px)` block of `packages/admin/src/styles.css`, replace the `.sidebar` line at `:151` and the `.topbar` line at `:158`:

```css
  /* sidebar becomes a single-line scrollable tab bar; brand + tabs stay on one row */
  .sidebar { flex-direction: row; align-items: center; gap: 6px; overflow-x: auto; padding: 10px 12px; min-width: 0; }
```

→

```css
  /* sidebar becomes a single-line scrollable tab bar; brand + tabs stay on one row.
     Sticky (z above .topbar) so switching view never means scrolling back to the top of a
     2500px Settings page. The four background layers are the same scroll-shadow trick as .tbl,
     tinted for the dark strip — 41% of the tabs are off-screen at 375px with no other hint. */
  .sidebar {
    flex-direction: row; align-items: center; gap: 6px; overflow-x: auto; padding: 10px 12px; min-width: 0;
    position: sticky; top: 0; z-index: 6;
    background-image:
      linear-gradient(to right, var(--sidebar) 40%, rgba(17,48,44,0)),
      linear-gradient(to left, var(--sidebar) 40%, rgba(17,48,44,0)),
      radial-gradient(farthest-side at 0 50%, rgba(0,0,0,.45), rgba(0,0,0,0)),
      radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,.45), rgba(0,0,0,0));
    background-repeat: no-repeat;
    background-position: left center, right center, left center, right center;
    background-size: 26px 100%, 26px 100%, 11px 100%, 11px 100%;
    background-attachment: local, local, scroll, scroll;
  }
```

and

```css
  .topbar { padding: 14px 16px; }
```

→

```css
  /* not sticky on mobile: the nav is. Two sticky bars at top:0 would overlap, and pinning the
     page title while the navigation scrolls away is the inversion the audit called out. */
  .topbar { padding: 14px 16px; position: static; }
```

- [ ] **Step 2: Scroll the active tab into view**

`packages/admin/src/App.tsx` — add `useRef` to the import at `:1`:

```tsx
import { useEffect, useRef, useState } from "react";
```

and inside `App()`, after the existing `useEffect` at `:49-53`, add:

```tsx
  // The mobile tab strip hides 41% of its tabs at 375px; without this the highlighted tab for
  // 方案 / 支付渠道 / 設定 sits past the right edge, so the strip never shows where you are.
  // scrollLeft rather than scrollIntoView: the latter can also scroll the document vertically.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = navRef.current?.parentElement; // .sidebar is the scroller, .nav is inside it
    const on = navRef.current?.querySelector<HTMLElement>("button.on");
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({ left: on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
  }, [view]);
```

and attach the ref at `:61`:

```tsx
        <nav className="nav" ref={navRef}>
```

- [ ] **Step 3: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

- [ ] **Step 4: Probe — active tab visible on every view, strip stays put while scrolling**

Create `$SCRATCH/ux44/tabs.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const ORIGIN = "http://localhost:5461";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
const R = {};
for (const [v, ready] of [["dashboard",".stats"],["payments",".tbl-cards tbody tr"],["users","table tbody tr"],
                          ["subscriptions","table tbody tr"],["plans","table tbody tr"],["tags","table tbody tr"],["settings",".actionrow"]]) {
  await send("Page.navigate", { url: `${ORIGIN}/?r=${Date.now()}${Math.random()}#${v}` });
  for (let i=0;i<70;i++){ await sleep(150); try { if (await ev(`!!document.querySelector(${JSON.stringify(ready)})`)) break; } catch {} }
  await sleep(900); // let the smooth scroll settle
  R[v] = await ev(`(() => {
    const sb = document.querySelector(".sidebar"), on = document.querySelector(".nav button.on");
    const r = on.getBoundingClientRect();
    return { tab: on.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right),
      fullyVisible: r.left >= -1 && r.right <= window.innerWidth + 1,
      stripPos: getComputedStyle(sb).position, stripZ: getComputedStyle(sb).zIndex,
      topbarPos: getComputedStyle(document.querySelector(".topbar")).position };
  })()`);
}
// does the strip stay pinned after scrolling a long page?
await send("Page.navigate", { url: `${ORIGIN}/?r=${Date.now()}#settings` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".actionrow")`)) break; }
await sleep(400);
await ev(`window.scrollTo(0, 1200)`); await sleep(400);
R.afterScroll = await ev(`(() => { const sb = document.querySelector(".sidebar").getBoundingClientRect();
  return { top: Math.round(sb.top), stillOnScreen: sb.top >= -1 && sb.bottom > 0 }; })()`);
console.log(JSON.stringify(R, null, 1));
process.exit(0);
```

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && "$SCRATCH/ux44/run.sh" t05
node "$SCRATCH/ux44/tabs.mjs" > "$SCRATCH/ux44/t05/tabs.json" && cat "$SCRATCH/ux44/t05/tabs.json"
```

Expected: `fullyVisible: true` on all seven views (baseline had 方案 / 支付渠道 / 設定 false); `stripPos "sticky"`, `stripZ "6"`, `topbarPos "static"`; `afterScroll.top === 0` and `stillOnScreen: true`. Also re-check `admin.json` for zero horizontal overflow.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/styles.css packages/admin/src/App.tsx
git commit -m "fix(admin): 行動版分頁條改 sticky、自動捲到目前分頁、加邊緣漸層

B3：方案／支付渠道／設定三頁的 active tab 原本在畫面外（fullyVisible false）→ 全部 true；
分頁條原本 position: static 會隨頁面捲走 → sticky top 0 (z 6)，.topbar 改 static 避免兩條互搶。"
```

---

## Task 6: B4 + B5 + B16 — Modal gets dialog semantics, focus management, Escape and scroll lock

**Files:**
- Modify: `packages/admin/src/ui.tsx:1` (imports) and `:34-46` (`Modal`)
- Modify: `packages/admin/src/styles.css` — add the `html.modal-open` lock rules near the modal block at `:117-129`

**Interfaces:**
- Consumes: nothing.
- Produces: `Modal`'s public props are unchanged — `{ title: string; onClose: () => void; children: ReactNode }`. Every existing call site (R2Notice, ConfirmDelete, UserModal, SubAddModal, SubEditModal, PlanModal, TagModal, SyncModal, RetractModal, ManualModal, LinkModal, ImportModal, InitiateModal, PaymentDetail) keeps working untouched. This is deliberate: one component fixes all seven probed modal scenes.

**All four findings live in this one component,** which is why they are one task: `role`/`aria-modal`/`aria-labelledby` (B4), focus-in / trap / restore (B4), Escape (B5), and background scroll lock (B16) are four aspects of the same 12-line component.

- [ ] **Step 1: Rewrite `Modal`**

`packages/admin/src/ui.tsx:1` — extend the import:

```tsx
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
```

`packages/admin/src/ui.tsx:34-46` — replace the whole `Modal` function:

```tsx
// Focusable descendants, in DOM order. `:not([disabled])` matters — every modal in this app
// disables its controls while a request is in flight, and a trap that cycles onto a disabled
// button silently swallows the Tab.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// Nesting is possible (PaymentDetail opens from MemberReview), so the scroll lock is refcounted
// rather than set/unset per modal.
let openModalCount = 0;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  // Move focus into the sheet on open and hand it back to whatever opened it on close. Without
  // this, a screen reader announces nothing and 12 consecutive Tabs all land on the table behind.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // The bottom sheet leaves ~357px of tappable backdrop at 375px; dragging it used to scroll the
  // page underneath. Locking on <html> covers both scrollers: body on mobile, .main on desktop.
  useEffect(() => {
    openModalCount += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      openModalCount -= 1;
      if (openModalCount === 0) document.documentElement.classList.remove("modal-open");
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((el) => el.offsetParent !== null); // skip anything inside a closed <details>
    if (els.length === 0) { e.preventDefault(); ref.current?.focus(); return; }
    const first = els[0]!, last = els[els.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 id={titleId}>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the lock rules**

In `packages/admin/src/styles.css`, immediately after the `.iconbtn` rule at `:129`:

```css
/* background scroll lock while a modal / bottom sheet is open (set by ui.tsx's Modal).
   Two selectors because the scrolling element differs by breakpoint: <body> below 1000px
   (.main is overflow: visible there), .main above it. */
html.modal-open, html.modal-open body { overflow: hidden; }
html.modal-open .main { overflow: hidden; }
```

- [ ] **Step 3: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

Expected: clean. If `React.KeyboardEvent` is flagged, import the type explicitly: `import { type KeyboardEvent as ReactKeyboardEvent } from "react"` and annotate `e: ReactKeyboardEvent<HTMLDivElement>`.

- [ ] **Step 4: Probe — all four findings**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot && "$SCRATCH/ux44/run.sh" t06
O="$SCRATCH/ux44/t06" node -e '
const f=require(process.env.O+"/focus.json"), a=require(process.env.O+"/admin.json");
console.log("escape closes modal:", f.modalOpenBefore === true && f.modalOpenAfterEscape === false);
console.log("body lock:", JSON.stringify(f.bodyLock));
console.log("tab inside modal — any OUTSIDE?:", f.tabWalkInModal.filter(s=>/OUTSIDE/.test(s)).length, "/", f.tabWalkInModal.length);
for (const k of Object.keys(a).filter(k=>/-modal@|R2/.test(k))) {
  const d = a[k].a && a[k].a.dialog; if (d) console.log(k.padEnd(34), "role", d.role, "| aria-modal", d.ariaModal, "| labelledby", !!d.ariaLabelled, "| focus inside", d.activeInsideModal);
}
'
```

Expected: escape closes `true` (was `false`); `bodyLock.bodyOverflow === "hidden"` and `htmlOverflow === "hidden"` (was `"visible"`); `0 / 12` OUTSIDE in `tabWalkInModal` (was 12/12); every `*-modal` scene reports `role "dialog"`, `aria-modal "true"`, `labelledby true`, `focus inside true` (all were `null` / `false`).

- [ ] **Step 5: Check the sheet still behaves (don't-break #3)**

```bash
O="$SCRATCH/ux44/t06" node -e '
const a=require(process.env.O+"/admin.json");
for (const k of Object.keys(a).filter(k=>/-modal@375$/.test(k)))
  console.log(k.padEnd(34), JSON.stringify(a[k].extra.backdrop), "| modal", JSON.stringify(a[k].extra.modal && {h:a[k].extra.modal.h, br:a[k].extra.modal.br, needsVScroll:a[k].extra.modal.needsVScroll}));
'
```

Expected: `place-items: end stretch`, `padding: 0px`, `border-radius: 16px 16px 0px 0px` on every sheet — unchanged from baseline.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/ui.tsx packages/admin/src/styles.css
git commit -m "feat(admin): Modal 補 dialog 語意、焦點進入／trap／還原、Escape 關閉、背景捲動鎖

B4/B5/B16 同一個元件：role/aria-modal/aria-labelledby 由全 null → 齊備；
開啟後 12 次 Tab 全落在背景表格 → 12/12 留在 sheet 內；Escape 由關不掉 → 關得掉；
body overflow visible → hidden（refcount，支援 PaymentDetail 疊在 MemberReview 上）。"
```

---

## Task 7: B6 + B7 + B18 + X3 — one contrast and focus pass

**Files:**
- Modify: `packages/admin/src/styles.css` — `:root` at `:1-13`, `.badge--pending` `:91`, `.field input:focus` `:115`, `.tag` `:208-209`, `.chip--off` `:185`, `.sidebar__foot` `:52`, `.field input…` border at `:112`, `.toolbar select/input` `:133`, `.mrow__reject input` `:246`, plus the new focus block
- Modify: `packages/web/src/styles.css` — `:root` at `:1-11`, `.note` border at `:155`

**Interfaces:**
- Consumes: nothing.
- Produces three new/redefined tokens that later tasks use by name:
  - `--muted` is **redefined** to `#6b6253` (was `#8b8173`). `--muted-strong` stays declared as an alias of the same value so no existing call site breaks.
  - `--line-strong: #948871` — form-field boundaries only. `--line` is untouched.
  - `--amber` is **redefined** to `#8f570f` (was `#b3701a`).
- Produces a global `:focus-visible` ring that every later task's new control inherits — no per-component focus styling needed anywhere else.

**Why redefine tokens instead of swapping call sites:** `--muted` has 30 usages across five files, ten of them inline `style={{ color: "var(--muted)" }}` in TSX. Every one of them is body text and every one of them fails 4.5:1. Changing the *token* fixes all thirty in one line and makes it impossible to miss a site; changing thirty call sites to `--muted-strong` would leave the failing token in the file for the next person to reach for. Same reasoning for `--amber` (five usages, four of them text, the fifth an 8px dot that only benefits from being darker).

**Measured values** (`contrast.mjs` maths, recomputed for this task):

| token / rule | before | after | ratio after |
|---|---|---|---|
| `--muted` on `--panel` / `--bg` / `#faf7f0` | 3.83 / 3.39 / 3.58 | `#6b6253` | 6.00 / 5.31 / 5.61 |
| web `--muted` on `--card` / `--paper` | 3.66 / 3.38 | `#6a6152` | 5.75 / 5.32 |
| `--amber` on `--panel` (純聲明) | 4.00 | `#8f570f` | 5.94 |
| `.tag--warn` amber on `#f6ead2` | 3.36 | (same token) | 4.98 |
| `.tag` ink on `#eee7d8` | 3.28 | `#6b6253` | 4.88 |
| `.badge--pending` / `.chip--off` ink on `#f3ede0` | 4.18 | `#7a5f27` | 5.15 |
| `.sidebar__foot` alpha on `--sidebar` | 4.28 | alpha `.72` | 6.24 |
| focus ring on `--panel` | 1.58 | `var(--teal)` | 6.12 |
| focus ring on `--sidebar` | — | `#cfe3df` | 10.59 |
| `--line-strong` on `#fffdf8` / `#ffffff` / `--bg` / web `--card` | 1.29 | `#948871` | 3.43 / 3.49 / 3.09 / 3.29 |

- [ ] **Step 1: Redefine the admin tokens**

`packages/admin/src/styles.css:1-13`:

```css
:root {
  --bg: #f3f1ea;
  --panel: #ffffff;
  --ink: #1f1c17;
  --muted: #8b8173;
  --line: #e7e0d2;
  --teal: #0f6e63;
  --teal-ink: #0a4d45;
  --amber: #b3701a;
  --red: #b23a2e;
  --sidebar: #11302c;
  --sidebar-ink: #cfe3df;
}
```

→

```css
:root {
  --bg: #f3f1ea;
  --panel: #ffffff;
  --ink: #1f1c17;
  /* 6.00:1 on --panel, 5.31:1 on --bg. Was #8b8173 (3.83 / 3.39) — used for th, .stat__label,
     .empty, .kv dt, the mobile card labels and ten inline styles, i.e. real body text, not
     decoration, so the token itself moves rather than each call site. */
  --muted: #6b6253;
  --muted-strong: #6b6253; /* kept as an alias: the Settings redesign already references it */
  --line: #e7e0d2;         /* card / table / topbar borders — deliberately soft, do not darken */
  --line-strong: #948871;  /* form-field boundaries only: 3.43:1 on #fffdf8, WCAG 1.4.11 */
  --teal: #0f6e63;
  --teal-ink: #0a4d45;
  /* 5.94:1 on --panel, 4.98:1 on .tag--warn's #f6ead2. Was #b3701a (4.00 / 3.36) — 純聲明 is a
     real status signal, not decoration. */
  --amber: #8f570f;
  --red: #b23a2e;
  --sidebar: #11302c;
  --sidebar-ink: #cfe3df;
}
```

- [ ] **Step 2: Delete the now-duplicate `--muted-strong` declaration**

`packages/admin/src/styles.css:165`:

```css
:root { --muted-strong: #6b6253; } /* darker muted for small helper text (>=4.5:1 on --bg) */
```

→ delete the line (it moved into the main `:root` in Step 1). Keep the `/* ── settings redesign ── */` comment above it.

- [ ] **Step 3: Fix the three literal-colour contrast failures**

`packages/admin/src/styles.css:91`:

```css
.badge--pending { background: #f3ede0; color: #8a6d2f; }
```
→
```css
.badge--pending { background: #f3ede0; color: #7a5f27; } /* 5.15:1 (was 4.18) */
```

`:185`:

```css
.chip--off { background: #f3ede0; color: #8a6d2f; }
```
→
```css
.chip--off { background: #f3ede0; color: #7a5f27; } /* 5.15:1 (was 4.18) */
```

`:208`:

```css
.tag { font-size: 10.5px; letter-spacing: .5px; padding: 2px 7px; border-radius: 999px; background: #eee7d8; color: #8a7d63; white-space: nowrap; }
```
→
```css
.tag { font-size: 10.5px; letter-spacing: .5px; padding: 2px 7px; border-radius: 999px; background: #eee7d8; color: #6b6253; white-space: nowrap; } /* 4.88:1 (was 3.28) */
```

`:52`:

```css
.sidebar__foot { font-size: 11.5px; color: rgba(207,227,223,0.55); padding: 6px 10px 0; }
```
→
```css
.sidebar__foot { font-size: 11.5px; color: rgba(207,227,223,0.72); padding: 6px 10px 0; } /* 6.24:1 (was 4.28) */
```

- [ ] **Step 4: Darken only the form-field borders (X3 — the owner's scoped decision)**

`packages/admin/src/styles.css:111-114`:

```css
.field input, .field select, .field textarea {
  width: 100%; padding: 9px 11px; border: 1.5px solid var(--line); border-radius: 9px;
  font: inherit; font-size: 14px; background: #fffdf8; color: var(--ink);
}
```
→
```css
.field input, .field select, .field textarea {
  width: 100%; padding: 9px 11px; border: 1.5px solid var(--line-strong); border-radius: 9px;
  font: inherit; font-size: 14px; background: #fffdf8; color: var(--ink);
}
```

`:133`:

```css
.toolbar select, .toolbar input { padding: 8px 11px; border: 1.5px solid var(--line); border-radius: 9px; font: inherit; background: var(--panel); }
```
→
```css
.toolbar select, .toolbar input { padding: 8px 11px; border: 1.5px solid var(--line-strong); border-radius: 9px; font: inherit; background: var(--panel); }
```

`:246`:

```css
.mrow__reject input {
  flex: 1 1 180px; padding: 9px 11px; border: 1.5px solid var(--line); border-radius: 9px;
```
→
```css
.mrow__reject input {
  flex: 1 1 180px; padding: 9px 11px; border: 1.5px solid var(--line-strong); border-radius: 9px;
```

Do **not** change `.card`, `.stat`, `.topbar`, `.preview`, `.link-box`, `.proof-img`, `details` or `hr` borders — those are the paper aesthetic the owner kept. Do not change the member page's `.drop` either (a dashed drop zone, outside the owner's `input/textarea/select` scope).

- [ ] **Step 5: Replace the invisible focus ring with a global one (B6)**

`packages/admin/src/styles.css:115`:

```css
.field input:focus, .field select:focus, .field textarea:focus { outline: 2px solid rgba(15,110,99,.3); outline-offset: 1px; }
```
→
```css
/* One global focus indicator. Was the app's ONLY :focus rule and it composited to 1.58:1 against
   --panel, far under WCAG 1.4.11's 3:1; every other interactive class fell back to the UA's thin
   blue line, invisible on a teal button and on the #11302c sidebar. outline-offset puts the ring
   on the surrounding surface rather than on the control, so one colour works for all of them. */
:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
.field input:focus-visible, .field select:focus-visible, .field textarea:focus-visible { outline-offset: 1px; }
.sidebar :focus-visible { outline-color: var(--sidebar-ink); } /* 10.59:1 on the dark strip */
/* a focused row must not push the table sideways, so the ring goes inside the cell box */
tbody tr.click:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
```

- [ ] **Step 6: Redefine the member page's muted token and darken its field border**

`packages/web/src/styles.css:5`:

```css
  --muted: #8a8073;
```
→
```css
  --muted: #6a6152;      /* 5.75:1 on --card, 5.32:1 on --paper (was #8a8073: 3.66 / 3.38) */
  --line-strong: #948871; /* form-field boundaries only — .note, and the select added in Task 17 */
```

`packages/web/src/styles.css:155`:

```css
  padding: 12px 14px; border: 1.5px solid var(--line); border-radius: 12px;
```
→
```css
  padding: 12px 14px; border: 1.5px solid var(--line-strong); border-radius: 12px;
```

`:158`:

```css
.note:focus, .drop:focus-within { outline: 2px solid rgba(15, 110, 99, 0.35); outline-offset: 1px; }
```
→
```css
.note:focus-visible, .drop:focus-within, .submit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 7: Update `contrast.mjs`'s token table so the harness measures the new values**

Edit `$SCRATCH/contrast.mjs` (harness, not the repo) — in the `T` object at `:9-14` set `muted: "#6b6253"`, `amber: "#8f570f"`, `wMuted: "#6a6152"`, and add `lineStrong: "#948871"`. In `rows`, change the three literal pairs (`.tag` → `#6b6253`, `.badge--pending` → `#7a5f27`, `.chip--off` → `#7a5f27`), change the `sidebar-ink@55%` row's alpha to `0.72`, change the focus-ring row to `["ADMIN", "focus ring --teal on --panel", "styles.css:115", ":focus-visible outline — needs 3:1", T.teal, T.panel, 3.0]`, and add two rows for `--line-strong` on `#fffdf8` and on web `--card` at `need 3.0`.

- [ ] **Step 8: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
pnpm --filter @chippot/web typecheck && VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build
"$SCRATCH/ux44/run.sh" t07
grep -E "FAIL" "$SCRATCH/ux44/t07/contrast.txt" || echo "NO FAILURES"
tail -2 "$SCRATCH/ux44/t07/contrast.txt"
```

Expected: `FAILURES: 2 / 36` — the only remaining fails are the two `--line` rows (card/topbar borders at 1.29:1), which the owner explicitly kept. Every other pair passes. Baseline was 15 / 34.

- [ ] **Step 9: Confirm the focus ring is now real**

```bash
O="$SCRATCH/ux44/t07" node -e '
const f=require(process.env.O+"/focus.json");
console.log("focus ring on .btn:", JSON.stringify(f.focusRing));
console.log(":focus selectors found in stylesheet:"); f.focusRingCss.forEach(s=>console.log("  "+s));
'
```

Expected: `focusRingCss` now lists `:focus-visible`, `.sidebar :focus-visible`, `tbody tr.click:focus-visible` and the `.field` overrides (baseline listed exactly one selector, the 1.58:1 one).

- [ ] **Step 10: Commit**

```bash
git add packages/admin/src/styles.css packages/web/src/styles.css
git commit -m "fix(a11y): 對比與焦點指示一次修齊（B6/B7/B18 ＋ X3 表單邊框）

--muted 3.39-3.83:1 → 6.00/5.31:1（改 token 值，一次涵蓋 30 個使用點含 10 個 inline style）；
--amber 4.00 → 5.94:1；.tag 3.28 → 4.88；badge--pending／chip--off 4.18 → 5.15；
sidebar__foot 4.28 → 6.24。全站唯一的 focus 樣式 1.58:1 → 全域 :focus-visible 6.12:1
（側欄用淺色 10.59:1）。X3：只有 input/textarea/select 邊框改 --line-strong 3.43:1，
卡片／表格／topbar 的 --line 紙感不動。contrast.mjs：15/34 FAIL → 2/36（僅剩刻意保留的 --line）。"
```

---

## Task 8: B2 — every form control to 16px so iOS Safari stops auto-zooming

**Files:**
- Modify: `packages/admin/src/styles.css:113` (`.field input/select/textarea`), `:247` (`.mrow__reject input`)
- Modify: `packages/web/src/styles.css:154` (`.note`)

**Interfaces:**
- Consumes: Task 7's `--line-strong` (same rules are being edited; do Task 7 first to avoid re-touching the line).
- Produces: no API change. The `.toolbar` controls are already 16px via `font: inherit` — that is the proof this works without a redesign.

**The regression to watch:** `styles.css:177-179` bottom-aligns same-row inputs in the two-up `.grid2` (`.grid2 .field input, .grid2 .field select { margin-top: auto }`). A taller control could break that alignment, so Step 4 measures it explicitly.

- [ ] **Step 1: Admin form controls**

`packages/admin/src/styles.css:113`:

```css
  font: inherit; font-size: 14px; background: #fffdf8; color: var(--ink);
```
→
```css
  /* 16px, not 14: iOS Safari zooms the viewport whenever a focused control is under 16px and does
     not restore the zoom on blur, so one tap on any admin field left the whole back office
     permanently zoomed and panned. .toolbar's controls have always been 16px (font: inherit) —
     that is the evidence this needs no visual redesign. */
  font: inherit; font-size: 16px; background: #fffdf8; color: var(--ink);
```

`:247`:

```css
  font: inherit; font-size: 14px; background: #fffdf8; color: var(--ink);
```
→
```css
  font: inherit; font-size: 16px; background: #fffdf8; color: var(--ink);
```

- [ ] **Step 2: Member page textarea**

`packages/web/src/styles.css:154`:

```css
  font-family: inherit; font-size: 15px; color: var(--ink);
```
→
```css
  font-family: inherit; font-size: 16px; color: var(--ink); /* <16px triggers iOS Safari auto-zoom */
```

- [ ] **Step 3: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin build && VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build
"$SCRATCH/ux44/run.sh" t08
O="$SCRATCH/ux44/t08" node -e '
const a=require(process.env.O+"/admin.json"), w=require(process.env.O+"/web.json");
const bad=Object.entries(a).flatMap(([k,v])=>(v.m?v.m.zoomy:[]).map(z=>k+" "+z.type+" "+z.fs+"px"));
console.log("admin controls under 16px:", bad.length, bad.slice(0,10));
console.log("web controls under 16px:", JSON.stringify(w.m ? w.m.zoomy : w));
'
```

Expected: admin `0` (baseline listed `number`, `text`, `text.mono`, `textarea`, `select-one`, `month` at 14px across Settings and every modal); web list empty except anything the select in Task 17 has not been styled into yet — note it and move on, Task 17 closes it.

- [ ] **Step 4: Verify the `.grid2` bottom alignment survived**

Create `$SCRATCH/ux44/grid2.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
for (const w of [375, 720, 1280]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 1000 });
  await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#settings` });
  for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".actionrow")`)) break; }
  await sleep(400);
  console.log(w, await ev(`(() => [...document.querySelectorAll(".grid2")].map(g => {
    const inputs = [...g.querySelectorAll(".field input, .field select")].map(i => Math.round(i.getBoundingClientRect().bottom));
    const rows = {}; for (const b of inputs) { const k = Math.round(b / 10); rows[k] = (rows[k] || 0) + 1; }
    return { bottoms: inputs, sharedRows: Object.values(rows).filter(n => n > 1).length };
  }))()`));
}
process.exit(0);
```

```bash
node "$SCRATCH/ux44/grid2.mjs" | tee "$SCRATCH/ux44/t08/grid2.txt"
```

Expected: at 1280 and 720 the two-up rows still share a bottom edge (`sharedRows >= 1`, bottoms equal in pairs); at 375 the grid is one column so pairs do not apply. If a pair separates, add `align-items: end` to `.grid2` and re-measure.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/styles.css packages/web/src/styles.css
git commit -m "fix(a11y): 表單控件 14px → 16px，解除 iOS Safari 聚焦永久放大

B2：admin 低於 16px 的控件由 6 類（Settings 與全部 modal 的 number/text/mono/textarea/select/month）
＋ MemberReview 退回原因 → 0；成員頁 .note 15px → 16px。.grid2 兩欄底部對齊已回歸確認。"
```

---

## Task 9: B8 + B20 — accessible names and document semantics

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx:188-195` (Bark), `:200-207` (Webhook), `:212-221` (自訂通知文字)
- Modify: `packages/admin/src/App.tsx:72` (`.topbar` → `<header>`)
- Modify: `packages/admin/src/styles.css` (add `.sr-only`)
- Modify: `packages/admin/src/views/Dashboard.tsx`, `Payments.tsx`, `Manage.tsx` (captions + `th scope`)
- Modify: `packages/web/src/App.tsx:171` (`.brand` → `h1`), `:196` (`.stub__hi` → `h2`), `:147-154` (`.note` label), `:52-55` (dead branch)
- Modify: `packages/web/src/styles.css:65` (`.brand` margin reset), `:100` (`.stub__hi` margin already set — confirm)

**Interfaces:**
- Consumes: nothing.
- Produces: `.sr-only` utility class in `packages/admin/src/styles.css`, used by the eight `<caption>` elements.

- [ ] **Step 1: Add the screen-reader-only utility**

Append to `packages/admin/src/styles.css`, just after the `.mono` rule at `:21`:

```css
/* visually hidden but announced: table captions that would be redundant on screen */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 2: Give the three Settings inputs real labels (B8)**

These three use a bare `<div className="field">` + `<span className="field__label">` instead of the `Field` component, so a screen reader announces only the placeholder. They cannot simply switch to `Field` — `Field` wraps its children in a `<label>` and two of them contain a `<button>` (送出測試), which must not be nested inside a label. Use explicit `htmlFor`/`id` instead.

`packages/admin/src/views/Settings.tsx:188-195`:

```tsx
          <div className="field">
            <span className="field__label">Bark（手機推播）</span>
            <span className="field__hint">貼上 Bark App 的裝置金鑰即可，不必自己組網址。</span>
            <div className="notify-row">
              <input value={form.bark_key} onChange={(e) => set("bark_key")(e.target.value)} disabled={busy} placeholder="例如 3hGxx6xNqpHE7h5keQZNni" />
              <TestButton kind="bark" form={form} />
            </div>
          </div>
```
→
```tsx
          <div className="field">
            {/* htmlFor rather than the Field component: the row contains a 送出測試 button, and a
                button nested inside a <label> would be activated by clicks meant for the label. */}
            <label className="field__label" htmlFor="set-bark-key">Bark（手機推播）</label>
            <span className="field__hint">貼上 Bark App 的裝置金鑰即可，不必自己組網址。</span>
            <div className="notify-row">
              <input id="set-bark-key" value={form.bark_key} onChange={(e) => set("bark_key")(e.target.value)} disabled={busy} placeholder="例如 3hGxx6xNqpHE7h5keQZNni" />
              <TestButton kind="bark" form={form} />
            </div>
          </div>
```

`:200-207` the same shape:

```tsx
          <div className="field">
            <label className="field__label" htmlFor="set-webhook-url">Webhook</label>
            <span className="field__hint">貼上 Discord／Google Chat／Slack 的 Webhook 網址，格式自動判斷。</span>
            <div className="notify-row">
              <input id="set-webhook-url" value={form.webhook_url} onChange={(e) => set("webhook_url")(e.target.value)} disabled={busy} placeholder="https://discord.com/api/webhooks/..." />
              <TestButton kind="webhook" form={form} />
            </div>
          </div>
```

`:214-220` — the textarea inside `details.custom` has no label element at all, only a hint. Add one:

```tsx
            <div className="field">
              <label className="field__label" htmlFor="set-notify-tpl">自訂通知文字</label>
              <span className="field__hint">可用 <code className="ph">{"{payer}"}</code> <code className="ph">{"{amount}"}</code> <code className="ph">{"{period}"}</code> <code className="ph">{"{admin_url}"}</code>。留空＝用預設。</span>
              <textarea id="set-notify-tpl" value={form.notify_template} onChange={(e) => set("notify_template")(e.target.value)} disabled={busy} rows={3} placeholder={DEFAULT_NOTIFY} style={{ width: "100%", fontFamily: "inherit" }} />
```

(keep the `unknownKeys` error banner and the closing tags below it unchanged)

- [ ] **Step 3: Give the admin a `<header>` landmark**

`packages/admin/src/App.tsx:72`:

```tsx
        <div className="topbar"><h1>{current.label}</h1></div>
```
→
```tsx
        <header className="topbar"><h1>{current.label}</h1></header>
```

- [ ] **Step 4: Caption and scope every table**

For all eight tables, add `scope="col"` to each `<th>` and a `<caption className="sr-only">` as the table's first child. The captions:

| file:anchor | caption |
|---|---|
| `Dashboard.tsx:72` 各方案 | `各方案本期收款統計` |
| `Dashboard.tsx:28` 推播狀態 | `本期推播通知狀態` |
| `Dashboard.tsx:98` 依渠道 | `依支付渠道分組的已驗證款項` |
| `Payments.tsx:130` | `繳費紀錄` |
| `Manage.tsx:36` | `成員名單` |
| `Manage.tsx:112` | `訂閱清單` |
| `Manage.tsx:206` | `方案清單` |
| `Manage.tsx:295` | `支付渠道清單` |

Worked example, `Payments.tsx:130-131`:

```tsx
          <table className="tbl-cards">
            <caption className="sr-only">繳費紀錄</caption>
            <thead><tr><th scope="col">成員</th><th scope="col">方案</th><th scope="col">期別</th><th scope="col" className="right">金額</th><th scope="col">狀態</th><th scope="col">申報渠道</th>{showProof && <th scope="col">憑證</th>}<th scope="col"><span className="sr-only">操作</span></th></tr></thead>
```

Note the trailing empty `<th>` gets an `.sr-only` label rather than staying blank — it is the actions column on six of the eight tables. Apply the same pattern everywhere a `<th></th>` appears.

- [ ] **Step 5: De-duplicate Manage's H1/H2**

Every Manage view emits `H1: 成員` (the topbar) and `H2: 成員` (the card head). Rename the card titles so the two headings say different things — the `Card title` prop only:

- `Manage.tsx:34` `title="成員"` → `title="成員名單"`
- `Manage.tsx:110` `title="訂閱"` → `title="訂閱清單"`
- `Manage.tsx:196` `title="方案"` → `title="方案清單"`
- `Manage.tsx:293` already `支付渠道（對帳分組）` — leave it

(Batch D owns terminology; these four are structural de-duplication, not a rename of a concept. Flag them in the PR body so D does not undo them.)

- [ ] **Step 6: Give the member page a heading outline**

`packages/web/src/App.tsx:171`:

```tsx
        <div className="brand">ChipPot</div>
```
→
```tsx
        <h1 className="brand">ChipPot</h1>
```

`:196`:

```tsx
      <div className="stub__hi">嗨，{name || "夥伴"}</div>
```
→
```tsx
      <h2 className="stub__hi">嗨，{name || "夥伴"}</h2>
```

`packages/web/src/styles.css:65-72` — add `margin: 0` to `.brand` so the `h1` default margin does not open a gap:

```css
.brand {
  font-family: "Fraunces", serif;
  font-weight: 600;
  font-size: 18px;
  letter-spacing: 0.5px;
  color: var(--accent-ink);
  margin: 0;
  padding: 18px 24px 0;
}
```

(`.stub__hi` already sets `margin: 12px 0 14px`, so the `h2` needs no further reset.)

- [ ] **Step 7: Name the member page's note field and drop the unreachable branch**

`packages/web/src/App.tsx:147-154` — add an accessible name (there is no visible label, so `aria-label` is right):

```tsx
        <textarea
          className="note"
          aria-label="備註"
          placeholder="備註 — 例如付款方式、轉帳末五碼"
          value={note}
          maxLength={300}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
```

`:50-55` — `:158` already disables the button on the same condition, so the error branch can never run. Keep the guard, drop the dead message:

```tsx
  async function submit() {
    if (!token) return;
    if (!canSubmit) return; // the button is disabled on the same condition (:158) — belt only
    setError(null);
```

- [ ] **Step 8: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
pnpm --filter @chippot/web typecheck && VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build
"$SCRATCH/ux44/run.sh" t09
O="$SCRATCH/ux44/t09" node -e '
const a=require(process.env.O+"/admin.json"), w=require(process.env.O+"/web.json");
const un=Object.entries(a).flatMap(([k,v])=>(v.a?v.a.unlabeled:[]).map(u=>k+" "+u.type+" ph=\""+u.ph+"\""));
console.log("admin inputs with no accessible name:", un.length, un);
console.log("landmarks @1280 settings:", JSON.stringify(a["settings@1280"].a.landmarks));
console.log("tables missing caption/scope:", Object.entries(a).flatMap(([k,v])=>(v.a?v.a.tables:[]).filter(t=>!t.caption||t.thScope<t.thCount).map(t=>k+" "+JSON.stringify(t))).slice(0,8));
console.log("manage headings:", a["users@1280"].a.headings);
console.log("web headings:", JSON.stringify(w.a ? w.a.headings : w));
console.log("web unlabeled:", JSON.stringify(w.a ? w.a.unlabeled : w));
'
```

Expected: admin unlabeled `0` (baseline: 3 — the Bark, Webhook and 自訂通知文字 controls); `landmarks.header === 1` (was 0); the missing-caption/scope list empty; `users@1280` headings show `H1:成員` + `H2:成員名單` (no duplicate); web headings start with `H1:ChipPot` in all three states; web unlabeled `0` (baseline had `.note`).

- [ ] **Step 9: Commit**

```bash
git add packages/admin/src/views/Settings.tsx packages/admin/src/App.tsx packages/admin/src/styles.css packages/admin/src/views/Dashboard.tsx packages/admin/src/views/Payments.tsx packages/admin/src/views/Manage.tsx packages/web/src/App.tsx packages/web/src/styles.css
git commit -m "fix(a11y): 補可及名稱與文件語意（B8/B20）

B8：設定頁 Bark／Webhook／自訂通知文字三個控件由只念得出 placeholder → 具名 label（用 htmlFor，
因為列內有按鈕不能包在 label 裡）。B20：.topbar 改 <header>（後台 header landmark 0 → 1）、
8 張表補 sr-only caption 與 th[scope]、Manage 重複的 H1/H2 拆開、成員頁補 h1/h2、
.note 補 aria-label、移除 !canSubmit 的不可達分支。"
```

---

## Task 10: B11 — the payments row becomes keyboard-operable

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx:136` (the `<tr className="click">`)

**Interfaces:**
- Consumes: Task 7's `tbody tr.click:focus-visible` ring.
- Produces: nothing other tasks depend on.

**Why not `role="button"`:** putting a button role on a `<tr>` destroys the row/cell relationship a screen reader uses to read the table. A focusable row with an Enter/Space handler and a descriptive `aria-label` keeps `row` semantics while making the interaction reachable. The row's inner buttons keep their own tab stops and their `stopPropagation`, so nothing double-fires.

- [ ] **Step 1: Make the row focusable and operable**

`packages/admin/src/views/Payments.tsx:136`:

```tsx
                <tr key={p.id} className="click" onClick={() => setSelected(p)}>
```
→
```tsx
                <tr
                  key={p.id}
                  className="click"
                  tabIndex={0}
                  aria-label={`${p.user_name} · ${p.plan_name} · ${p.period} 繳費明細`}
                  onClick={() => setSelected(p)}
                  /* PaymentDetail was reachable only by clicking the row background; the keyboard
                     detour (成員 → MemberReview → 完整資訊) works but nobody would find it.
                     No role="button": that would strip the row/cell semantics screen readers need. */
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return; // a button inside the row handles its own keys
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p); }
                  }}
                >
```

- [ ] **Step 2: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

- [ ] **Step 3: Probe — tab to a row, press Enter, expect the detail modal**

Create `$SCRATCH/ux44/rowkb.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
const key = async (k, code, kc) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
};
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#payments` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector("tr.click")`)) break; }
await sleep(400);
const R = {};
R.attrs = await ev(`(() => { const tr = document.querySelector("tr.click");
  return { tabindex: tr.getAttribute("tabindex"), role: tr.getAttribute("role"),
           ariaLabel: tr.getAttribute("aria-label") }; })()`);
await ev(`document.querySelector("tr.click").focus()`);
await sleep(150);
R.focusRing = await ev(`(() => { const s = getComputedStyle(document.querySelector("tr.click"));
  return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor }; })()`);
await key("Enter", "Enter", 13);
await sleep(400);
R.modalAfterEnter = await ev(`!!document.querySelector(".modal")`);
R.modalTitle = await ev(`document.querySelector(".modal h3") && document.querySelector(".modal h3").textContent`);
await key("Escape", "Escape", 27); await sleep(300);
await ev(`document.querySelector("tr.click").focus()`);
await key(" ", "Space", 32); await sleep(400);
R.modalAfterSpace = await ev(`!!document.querySelector(".modal")`);
console.log(JSON.stringify(R, null, 1));
process.exit(0);
```

```bash
"$SCRATCH/ux44/run.sh" t10
node "$SCRATCH/ux44/rowkb.mjs" > "$SCRATCH/ux44/t10/rowkb.json" && cat "$SCRATCH/ux44/t10/rowkb.json"
```

Expected: `tabindex "0"`, `role null`, an `aria-label` naming the member/plan/period; `modalAfterEnter true`, `modalAfterSpace true`, `modalTitle` matching the focused row; the focus ring resolves to a 2px teal outline (baseline: `tabindex null, role null`, no key handler, nothing).

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Payments.tsx
git commit -m "fix(a11y): 繳費列可用鍵盤開啟明細（B11）

tr.click 由 tabindex/role/keydown 全無 → tabIndex 0 ＋ Enter/Space 開啟 PaymentDetail ＋
描述性 aria-label。刻意不加 role=button，以保留 row/cell 語意。"
```

---

## Task 11: B17 — the four remaining sub-24px / awkward tap targets

**Files:**
- Modify: `packages/admin/src/styles.css` — `.mrow__facts .linkbtn` (new), `details … > summary` at `:194`, `input[type=checkbox]` (new), `.modal__body` button widths inside the `≤1000px` block at `:300`

**Interfaces:**
- Consumes: the 1000px constant from Task 3.
- Produces: nothing other tasks depend on.

The four measured offenders: `完整資訊` 52×19 (`MemberReview.tsx:110`), `details > summary` 19px tall (`Settings.tsx:196,212`), a bottom sheet's primary action 58×42 tucked at the left edge (`styles.css:300` sets a height but no width), checkbox glyphs 13×13 inside a label that measures exactly 24px with no margin.

- [ ] **Step 1: `完整資訊` gets the same treatment the payments cards already give `.linkbtn`**

Append after `.mrow__facts` in `packages/admin/src/styles.css` (`:241`):

```css
/* the only sub-24px control in an otherwise well-sized view — same fix as the payments card's
   .linkbtn (styles.css:285), which was never applied here */
.mrow__facts .linkbtn { display: inline-flex; align-items: center; min-height: 32px; }
```

- [ ] **Step 2: Disclosure summaries become a real strip**

`packages/admin/src/styles.css:194`:

```css
details.custom > summary, details.adv > summary { cursor: pointer; font-size: 13px; color: var(--teal-ink); list-style: none; user-select: none; }
```
→
```css
details.custom > summary, details.adv > summary {
  cursor: pointer; font-size: 13px; color: var(--teal-ink); list-style: none; user-select: none;
  display: flex; align-items: center; min-height: 32px; /* was a 19px strip */
}
```

- [ ] **Step 3: Checkboxes get 5px of margin above the 24px threshold**

Append after the `.field input:focus-visible` rules in `packages/admin/src/styles.css`:

```css
/* 13×13 glyphs inside a label that measured exactly 24px — at the threshold with no margin.
   accent-color keeps the checked state on-brand now that the box is big enough to see. */
input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--teal); }
```

- [ ] **Step 4: Sheet actions go full width**

Inside the `@media (max-width: 1000px)` cards/sheet block, replace `styles.css:300`:

```css
  .modal__body .btn { min-height: 42px; }
```
→
```css
  /* the payments cards got width:100% (styles.css:288); the sheets never did, so UserModal's
     儲存 was 58×42 tucked at the left edge of a 375px sheet. Direct children go full width;
     a .btn-row shares the width between its buttons instead of stacking them. */
  .modal__body .btn { min-height: 42px; }
  .modal__body > .btn { width: 100%; }
  .modal__body .btn-row { gap: 8px; }
  .modal__body .btn-row .btn { flex: 1 1 auto; }
```

- [ ] **Step 5: Build and probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin build
"$SCRATCH/ux44/run.sh" t11
O="$SCRATCH/ux44/t11" node -e '
const a=require(process.env.O+"/admin.json"), f=require(process.env.O+"/focus.json"), b=require(process.env.O+"/boundary.json");
const taps=Object.entries(a).filter(([k])=>/@375$|@720$/.test(k)).flatMap(([k,v])=>(v.m?v.m.taps:[]).map(t=>k+" | "+t.tag+"."+t.cls.slice(0,18)+' "'+t.txt+'" '+t.w+"x"+t.h));
console.log("sub-24px targets:", taps.length); taps.forEach(t=>console.log("  "+t));
console.log("完整資訊:", JSON.stringify(f.memberReview.links));
console.log("mreview sizes (dont-break #5):", JSON.stringify(f.memberReview.btns.slice(0,4)), "back:", f.memberReview.back);
console.log("reject same row:", f.memberReviewReject.sameRow, f.memberReviewReject.input);
console.log("checkbox:", JSON.stringify(b.checkbox));
'
```

Expected: sub-24px list empty; `完整資訊` now ≥32px tall; MemberReview's bulk button still ~347×46 and per-row 核准/退回 still ~162×40 / 143×40 with the reject input on the same row (don't-break #5); `b.checkbox.checkbox` now `18x18` with the label ≥28px.

- [ ] **Step 6: Check the sheet buttons individually**

Create `$SCRATCH/ux44/sheetbtns.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
for (const [hash, ready, act] of [
  ["users", "table tbody tr", `[...document.querySelectorAll("td.right .btn")].find(b=>b.textContent.trim()==="編輯").click()`],
  ["users", "table tbody tr", `[...document.querySelectorAll("td.right .btn")].find(b=>b.textContent.trim()==="刪除").click()`],
  ["subscriptions", "table tbody tr", `[...document.querySelectorAll(".card__head .btn")].find(b=>b.textContent.includes("新增")).click()`],
]) {
  await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}${Math.random()}#${hash}` });
  for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(${JSON.stringify(ready)})`)) break; }
  await sleep(350); await ev(act);
  for (let i=0;i<40;i++){ await sleep(150); if (await ev(`!!document.querySelector(".modal")`)) break; }
  await sleep(300);
  console.log(hash, await ev(`[...document.querySelectorAll(".modal__body .btn")].map(b=>{const r=b.getBoundingClientRect();
    return b.textContent.trim()+" "+Math.round(r.width)+"x"+Math.round(r.height)+" @x="+Math.round(r.left);})`));
}
process.exit(0);
```

```bash
node "$SCRATCH/ux44/sheetbtns.mjs" | tee "$SCRATCH/ux44/t11/sheetbtns.txt"
```

Expected: UserModal's 儲存 is now full-width (~343×42) or, when 解除綁定 is present, the two share the row at ~167 each; ConfirmDelete's 取消/確認刪除 both ≥42px tall and no longer 58px wide at the left edge.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src/styles.css
git commit -m "fix(a11y): 小尺寸觸控目標四處補齊（B17）

完整資訊 52×19 → ≥32px；details > summary 19px → 32px；checkbox glyph 13×13 → 18×18
（外層 label 由恰好 24px 變成有餘裕）；bottom sheet 主行動由 58×42 靠左 → 滿寬 42px，
.btn-row 內則等分。行動版 375/720 低於 24px 的目標歸零。"
```

---

## Task 12: ⚠️REBASE-SENSITIVE — B9: the payments toolbar stops eating 41% of the fold

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx` — the `<div className="toolbar">` (currently `:110-123`)
- Modify: `packages/admin/src/styles.css` — `.toolbar` / `.pills` inside the `≤1000px` block

> ⚠️ **Rebase first.** Batch A (#43) rewrites this toolbar's copy and may re-route 收回本期開繳 / 重新同步本期. Rebase onto post-A `main`, then find the toolbar by searching `Payments.tsx` for `className="toolbar"` and identify the four (or however many survive) one-off action buttons — the ones that are *not* the 期別 `<input type="month">`, the 全部期別 button, or the status `.pills`. Wrap **whatever that set turns out to be**. Do not rename any button, do not change any `title`, do not touch `.btn--danger` styling; A owns all of that.

**Files (intent form):** wrap the toolbar's one-off action buttons in a single `<div className="toolbar__acts">`; leave every button's props, order and copy exactly as they are.

**Interfaces:**
- Consumes: Task 3's 1000px constant, Task 4's scroll-shadow pattern (the same four background layers, re-tinted for `--bg`).
- Produces: `.toolbar__acts`, which Task 13 does **not** use (Dashboard's toolbar has one control).

**Acceptance (this is what "done" means, whatever A left behind):** at 375×812, `.toolbar` height ≤ 130px (was 183), the first payment card's top ≤ 240 (was 330), and ≥ 3 payment rows above the fold (was 2). Zero horizontal page overflow.

- [ ] **Step 1: Wrap the one-off actions**

In `Payments.tsx`, the four buttons after the `.grow` spacer become one group. Pre-rebase the edit reads:

```tsx
        <div className="grow" style={{ flex: 1 }} />
        <button className="btn" disabled={!effPeriod} title={effPeriod ? "對齊本期帳單到目前名單／現價" : "請先選擇單一期別"} onClick={() => setSync(true)}>重新同步本期</button>
        <button className="btn btn--danger" disabled={!effPeriod} title={effPeriod ? "刪除本期未繳帳單，期別回到未開繳" : "請先選擇單一期別"} onClick={() => setRetract(true)}>收回本期開繳</button>
        <button className="btn" onClick={() => setShowLink(true)}>產生上傳連結</button>
        <button className="btn btn--primary" onClick={() => setShowManual(true)}>手動補登</button>
      </div>
```
→
```tsx
        <div className="grow" style={{ flex: 1 }} />
        {/* One group so the four one-off period tools can become a single scrollable row on a
            phone instead of four stacked bands. Below 1000px .toolbar__acts is a nowrap scroller
            with an edge fade; above it, it is a plain flex row and looks unchanged. */}
        <div className="toolbar__acts">
          <button className="btn" disabled={!effPeriod} title={effPeriod ? "對齊本期帳單到目前名單／現價" : "請先選擇單一期別"} onClick={() => setSync(true)}>重新同步本期</button>
          <button className="btn btn--danger" disabled={!effPeriod} title={effPeriod ? "刪除本期未繳帳單，期別回到未開繳" : "請先選擇單一期別"} onClick={() => setRetract(true)}>收回本期開繳</button>
          <button className="btn" onClick={() => setShowLink(true)}>產生上傳連結</button>
          <button className="btn btn--primary" onClick={() => setShowManual(true)}>手動補登</button>
        </div>
      </div>
```

- [ ] **Step 2: Style the group**

Append to `packages/admin/src/styles.css` near `.toolbar` (`:132`), outside any media query:

```css
/* above the breakpoint this is just the row of buttons the toolbar always had */
.toolbar__acts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
```

and inside the `@media (max-width: 1000px)` shell block (the one that already contains `.toolbar .grow { display: none }`), append:

```css
  /* The toolbar was 183px tall at 375px — the 期別 row, two rows of status pills and four
     buttons each on its own line — leaving 2 payment rows above the fold. Both the pills and
     the one-off tools become single scrollable rows with the same edge fade as .tbl. */
  .toolbar { gap: 8px; }
  .pills, .toolbar__acts {
    flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;
    width: 100%; padding-bottom: 2px;
    background-color: var(--bg);
    background-image:
      linear-gradient(to right, var(--bg) 40%, rgba(243,241,234,0)),
      linear-gradient(to left, var(--bg) 40%, rgba(243,241,234,0)),
      radial-gradient(farthest-side at 0 50%, rgba(31,28,23,.13), rgba(31,28,23,0)),
      radial-gradient(farthest-side at 100% 50%, rgba(31,28,23,.13), rgba(31,28,23,0));
    background-repeat: no-repeat;
    background-position: left center, right center, left center, right center;
    background-size: 24px 100%, 24px 100%, 10px 100%, 10px 100%;
    background-attachment: local, local, scroll, scroll;
  }
  .pills .pill, .toolbar__acts .btn { flex: 0 0 auto; }
```

- [ ] **Step 3: Build and probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
"$SCRATCH/ux44/run.sh" t12
O="$SCRATCH/ux44/t12" node -e '
const f=require(process.env.O+"/focus.json"), a=require(process.env.O+"/admin.json");
const t=f.paymentsToolbar;
console.log("toolbar h:", t.toolbarH, "(<=130)  first card y:", t.firstCardTop, "(<=240)  rows above fold:", t.rowsAboveFold, "(>=3)");
console.log("buttons:", JSON.stringify(t.buttons));
console.log("overflow scenes:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
console.log("payments@1280 toolbar rows unchanged?", JSON.stringify(a["payments@1280"].m.scrollers.map(s=>s.cls+" "+s.hidden)));
'
```

Expected: toolbar ≤130px, first card ≤240, ≥3 rows above the fold, zero overflow. At 1280 the toolbar must still be one flat row — `.pills` and `.toolbar__acts` must **not** appear as scrollers there.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Payments.tsx packages/admin/src/styles.css
git commit -m "fix(admin): 繳費審核工具列在 375px 由 183px 降到 <=130px（B9）

四顆一次性期別工具包進 .toolbar__acts；行動版 .pills 與 .toolbar__acts 改成單行橫捲
（沿用 .tbl 的邊緣漸層），第一張卡由 y=330 → <=240，首屏可見列數 2 → >=3。
按鈕文案／順序／danger 樣式一律不動（屬批次 A）。"
```

---

## Task 13: ⚠️REBASE-SENSITIVE — B10: Dashboard's 各方案 keeps its row label, 推播狀態's actions come on screen

**Files:**
- Modify: `packages/admin/src/views/Dashboard.tsx` — the `PushStatus` table (currently `:27-35`), the 各方案 wrapper (`:71`, already pinned in Task 4)

> ⚠️ **Rebase first.** Batch A (#43) rewrites `PushStatus`'s two buttons: 重置 gains a confirm (or is redirected to 收回本期開繳) and 立即重發 gains a preview modal; the row may gain a third control. Rebase onto post-A `main`, then find the table by searching `Dashboard.tsx` for `推播狀態`. **The intent is layout only:** whatever controls that action cell ends up holding must be fully on screen at 375px. Do not change their labels, handlers, confirmations or colours.

**Interfaces:**
- Consumes: Task 2's card CSS (including the multi-button action cell), Task 4's `.tbl--pin-*`.
- Produces: nothing other tasks depend on.

**Baseline being fixed:** 各方案 is 646px of table in a 345px container with 301px hidden and a non-sticky first column, so scrolling right to read 應收 loses the 方案 name (Task 4 already pinned it — this task verifies it). 推播狀態's 重置 sits at `left=438` on a 375px viewport, i.e. entirely off screen, with 立即重發 half visible.

- [ ] **Step 1: Card-ify the push-status table**

`packages/admin/src/views/Dashboard.tsx:14-23` — the `Row` component's cells get labels:

```tsx
  const Row = ({ label, type, sentAt }: { label: string; type: string; sentAt: string | null | undefined }) => (
    <tr>
      <td data-label="通知">{label}</td>
      <td data-label="狀態" className="mono" style={{ fontSize: 12.5 }}>{sentAt ? `已發送 ${sentAt}` : "未發送"}</td>
      <td className="right">
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resendNotification(type, period), `r${type}`)}>{busy === `r${type}` ? "…" : "立即重發"}</button>{" "}
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resetNotification(type, period), `x${type}`)}>{busy === `x${type}` ? "…" : "重置"}</button>
      </td>
    </tr>
  );
```

and `:27-34` — the wrapper and table:

```tsx
      <div className="tbl tbl--pin-last">
        <table className="tbl-cards">
          <caption className="sr-only">本期推播通知狀態</caption>
          <thead><tr><th scope="col">通知</th><th scope="col">狀態</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
```

(the `<caption>` and `scope` may already be there from Task 9 — keep them, only add the two classes and the two `data-label`s)

- [ ] **Step 2: Build and probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
"$SCRATCH/ux44/run.sh" t13
node "$SCRATCH/ux44/wide.mjs" > "$SCRATCH/ux44/t13/wide.json"
O="$SCRATCH/ux44/t13" node -e '
const f=require(process.env.O+"/focus.json"), a=require(process.env.O+"/admin.json"), w=require(process.env.O+"/wide.json");
console.log("dashboard actions @375:", f.actions_dashboard.offscreenCount + "/" + f.actions_dashboard.n,
            "| sample:", JSON.stringify(f.actions_dashboard.sample));
console.log("各方案 first col position @1280:", w["1280"].dashboard.firstCells[0].pos);
console.log("overflow scenes:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
console.log("stat bleeders @375 (dont-break #6):", JSON.stringify(a["dashboard@375"].m.bleeders));
'
```

Expected: `dashboard actions @375: 0/N` (baseline had 重置 at `left=438` on a 375px viewport); 各方案's first cell `position: sticky` at 1280; zero overflow; no `.stat__value` bleeder at 375 (don't-break #6 — the 7-digit 應收總額 clamp).

- [ ] **Step 3: Commit**

```bash
git add packages/admin/src/views/Dashboard.tsx
git commit -m "fix(admin): 看板推播狀態行動版卡片化、各方案首欄 sticky（B10）

重置鈕原本在 375px 的 left=438（畫面外）→ 卡片內滿寬可點；各方案 7 欄表右滑時
不再失去方案名（首欄 sticky，Task 4 的 .tbl--pin-first）。按鈕文案與確認流程屬批次 A，未更動。"
```

---

## Task 14: B12 — searchable member/plan pickers and filterable Manage tables

**Files:**
- Modify: `packages/admin/src/ui.tsx` (add `FilterSelect`, add `TableFilter`)
- Modify: `packages/admin/src/views/Manage.tsx` — `SubAddModal:156-157`, and the 成員 / 訂閱 card heads
- Modify: `packages/admin/src/views/Payments.tsx` — `ManualModal:334-339`, `LinkModal:382-387`
- Modify: `packages/admin/src/styles.css` (add `.fsel__q`, `.cardtools`)

**Interfaces:**
- Consumes: Task 7's focus ring, Task 9's label conventions.
- Produces two exported components:

```tsx
export function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;   // default "選擇…"
  disabled?: boolean;
}): JSX.Element;

export function TableFilter(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: number;
  total: number;
}): JSX.Element;
```

**Scope note:** the audit's B12 also covers `/payments` having no `LIMIT` and Manage having no sorting. Both are worker/API changes and this batch is pure frontend — they stay with batch E. What ships here is the client-side degradation the Discord side already has.

**The borrowed idea:** `handler.ts:306-366` degrades a >25-person list into autocomplete plus a search modal rather than truncating it. The same principle applies here: below a threshold, show the plain native control; above it, put a filter box in front of it. No combobox library, no new dependency — a text input that narrows the `<option>` list.

- [ ] **Step 1: Add `FilterSelect` and `TableFilter` to `ui.tsx`**

Append to `packages/admin/src/ui.tsx`:

```tsx
// Below this many options a native <select> is fine on a phone; above it, scrolling a few hundred
// names in the platform picker is the problem the Discord side solved with autocomplete + a search
// modal (handler.ts:306-366). Same idea, simplest possible form: a filter in front of the select.
const FILTER_THRESHOLD = 12;

export function FilterSelect({ label, value, onChange, options, placeholder = "選擇…", disabled }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string; disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : [...options];
  // Keep the current choice selectable even when the filter excludes it, or the select would
  // render blank and the next submit would silently send a stale value.
  if (value && !shown.some((o) => o.value === value)) {
    const cur = options.find((o) => o.value === value);
    if (cur) shown.unshift(cur);
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={`${id}-select`}>{label}</label>
      {options.length > FILTER_THRESHOLD && (
        <input className="fsel__q" type="search" value={q} disabled={disabled}
          placeholder={`搜尋${label}…`} aria-label={`搜尋${label}`}
          onChange={(e) => setQ(e.target.value)} />
      )}
      <select id={`${id}-select`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {shown.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {needle && <span className="field__hint">顯示 {shown.length} / {options.length}</span>}
    </div>
  );
}

export function TableFilter({ value, onChange, placeholder, shown, total }: {
  value: string; onChange: (v: string) => void; placeholder: string; shown: number; total: number;
}) {
  return (
    <span className="cardtools">
      <input className="fsel__q" type="search" value={value} placeholder={placeholder}
        aria-label={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value.trim() && <span className="field__hint">{shown} / {total}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Style them**

Append to `packages/admin/src/styles.css` near the form rules:

```css
/* filter box in front of a long <select>, and in a card head */
.fsel__q {
  width: 100%; padding: 8px 11px; margin-bottom: 6px;
  border: 1.5px solid var(--line-strong); border-radius: 9px;
  font: inherit; font-size: 16px; background: #fffdf8; color: var(--ink);
}
.cardtools { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.cardtools .fsel__q { width: 180px; margin-bottom: 0; }
@media (max-width: 1000px) {
  /* the card head stacks; a 180px box next to a 新增 button leaves nothing for either */
  .card__head { flex-wrap: wrap; gap: 8px; }
  .cardtools { flex: 1 1 100%; }
  .cardtools .fsel__q { width: 100%; }
}
```

- [ ] **Step 3: Use `FilterSelect` in the four full-roster pickers**

`packages/admin/src/views/Manage.tsx` — update the import at `:3`:

```tsx
import { useAsync, Card, Modal, Field, Empty, FilterSelect, TableFilter } from "../ui";
```

`SubAddModal:156-157` becomes:

```tsx
      <FilterSelect label="成員" value={f.user_id} disabled={busy}
        onChange={(v) => set("user_id", v)}
        options={(users.data?.users ?? []).map((u) => ({ value: String(u.id), label: u.display_name }))} />
      <FilterSelect label="方案" value={f.plan_id} disabled={busy}
        onChange={(v) => set("plan_id", v)}
        options={(plans.data?.plans ?? []).filter((p) => p.active).map((p) => ({ value: String(p.id), label: `${p.name}（NT$${p.monthly_amount}）` }))} />
```

`packages/admin/src/views/Payments.tsx` — update the import at `:3` to include `FilterSelect`, then `ManualModal:334-339`:

```tsx
      <FilterSelect label="訂閱" value={subId} disabled={busy} onChange={setSubId}
        options={(subs.data?.subscriptions ?? []).filter((s) => s.status === "active")
          .map((s) => ({ value: String(s.id), label: `${s.user_name} · ${s.plan_name}` }))} />
```

and `LinkModal:382-387`:

```tsx
      <FilterSelect label="成員" value={userId} disabled={busy} onChange={setUserId}
        options={(users.data?.users ?? []).map((u) => ({ value: String(u.id), label: u.display_name }))} />
```

- [ ] **Step 4: Filter the two big Manage tables**

In `Users()` (`Manage.tsx:27-63`), add the state and the filtered list:

```tsx
export function Users() {
  const { data, loading, error, reload } = useAsync(() => api.users(), []);
  const [edit, setEdit] = useState<User | null | undefined>(undefined); // undefined=closed, null=new
  const [del, setDel] = useState<User | null>(null);
  const [q, setQ] = useState("");
  const all = data?.users ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((u) => [u.display_name, u.email ?? "", u.discord_id ?? ""].some((s) => s.toLowerCase().includes(needle)))
    : all;
```

and the card head + body:

```tsx
      <Card title="成員名單" action={
        <>
          <TableFilter value={q} onChange={setQ} placeholder="搜尋名稱／Email／Discord ID" shown={shown.length} total={all.length} />
          <button className="btn btn--primary" onClick={() => setEdit(null)}>新增成員</button>
        </>
      }>
```

then map over `shown` instead of `data?.users` in the `<tbody>`, and add an empty state after the loading row:

```tsx
              {!loading && shown.length === 0 && <tr><td colSpan={4}><Empty>{needle ? "沒有符合的成員" : "尚無成員"}</Empty></td></tr>}
```

Do the same in `Subscriptions()` (`Manage.tsx:102-141`) with `placeholder="搜尋成員／方案"` and

```tsx
  const shown = needle
    ? all.filter((s) => [s.user_name, s.plan_name, s.status].some((x) => String(x).toLowerCase().includes(needle)))
    : all;
```

Leave 方案 and 支付渠道 alone — they hold a handful of rows and 方案 already has a provider pill filter.

- [ ] **Step 5: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

If `Card`'s `action` prop rejects a fragment, widen its type in `ui.tsx:61` — it is already `ReactNode`, so a fragment is fine; a TS error here means something else went wrong.

- [ ] **Step 6: Probe — filter narrows, selection survives, no regressions**

Create `$SCRATCH/ux44/filter.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
const setVal = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)});
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  s.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
const R = {};
// table filter
await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#users` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector("table tbody tr")`)) break; }
await sleep(400);
R.rowsBefore = await ev(`document.querySelectorAll(".tbl-cards tbody tr").length`);
await ev(setVal(".cardtools .fsel__q", "廖"));
await sleep(300);
R.rowsAfter = await ev(`document.querySelectorAll(".tbl-cards tbody tr").length`);
R.counter = await ev(`document.querySelector(".cardtools .field__hint") && document.querySelector(".cardtools .field__hint").textContent`);
await ev(setVal(".cardtools .fsel__q", "zzzz"));
await sleep(300);
R.emptyState = await ev(`document.querySelector(".tbl-cards tbody .empty") && document.querySelector(".tbl-cards tbody .empty").textContent`);
// FilterSelect inside a modal (LinkModal has 9 members — under the threshold; ManualModal has 9 subs)
await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#payments` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".tbl-cards tbody tr")`)) break; }
await sleep(400);
await ev(`[...document.querySelectorAll(".toolbar__acts .btn, .toolbar .btn")].find(b=>b.textContent.includes("手動補登")).click()`);
for (let i=0;i<40;i++){ await sleep(150); if (await ev(`!!document.querySelector(".modal")`)) break; }
await sleep(400);
R.modalSelects = await ev(`[...document.querySelectorAll(".modal select")].map(s => ({ opts: s.options.length,
  labelled: !!(s.id && document.querySelector('label[for="' + s.id + '"]')) }))`);
R.filterBoxShown = await ev(`!!document.querySelector(".modal .fsel__q")`);
R.zoomy = await ev(`[...document.querySelectorAll(".modal input, .modal select")].filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).length`);
console.log(JSON.stringify(R, null, 1));
process.exit(0);
```

```bash
"$SCRATCH/ux44/run.sh" t14
node "$SCRATCH/ux44/filter.mjs" > "$SCRATCH/ux44/t14/filter.json" && cat "$SCRATCH/ux44/t14/filter.json"
```

Expected: `rowsBefore 9`, `rowsAfter 1`, counter reads `1 / 9`, `emptyState` is 沒有符合的成員; every modal `<select>` reports `labelled: true`; `zoomy 0`. With the 9-member stub the filter box inside modals is correctly absent (`filterBoxShown false`) — to prove the >12 branch, temporarily raise the stub: edit `$SCRATCH/mob-lib.mjs`'s `Array.from({ length: 9 }` to `{ length: 30 }`, re-run, confirm `filterBoxShown true` and that picking a filtered-out member keeps the value, then **revert the stub**.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src/ui.tsx packages/admin/src/styles.css packages/admin/src/views/Manage.tsx packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): 名單搜尋（B12 前端部分）

借用 Discord >25 的降級思路（handler.ts:306-366）：選項超過 12 個時在 select 前面加篩選框，
未超過就維持原生 select；成員／訂閱兩張表加卡片頭搜尋與 N / M 計數。
無新增相依。/payments 沒有 LIMIT 與表格排序屬 worker 變更，留在批次 E。"
```

---

## Task 15: B13 — errors offer a way out

**Files:**
- Modify: `packages/admin/src/ui.tsx` (add `ErrorNote`)
- Modify: `packages/admin/src/styles.css` (`.error-banner` becomes a flex row)
- Modify: `packages/admin/src/views/Payments.tsx:126`, `Dashboard.tsx:56`, `Manage.tsx:33,109,195,292`, `Settings.tsx:152`

**Interfaces:**
- Consumes: `useAsync`'s existing `reload` (`ui.tsx:20`), which no error UI has ever called.
- Produces:

```tsx
export function ErrorNote(props: { message: string; onRetry?: () => void }): JSX.Element;
```

- [ ] **Step 1: Add `ErrorNote`**

Append to `packages/admin/src/ui.tsx`:

```tsx
// useAsync has always returned `reload` and no error UI ever used it: a failed load left a red
// line and no way forward. The 401/403 case is special — api.ts turns it into 未授權，請重新登入，
// but Cloudflare Access only re-issues a session on a fresh page load, so that button reloads.
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const needsLogin = message.includes("重新登入");
  return (
    <div className="error-banner error-banner--act" role="alert">
      <span>{message}</span>
      {needsLogin
        ? <button className="btn" onClick={() => window.location.reload()}>重新登入</button>
        : onRetry && <button className="btn" onClick={onRetry}>重試</button>}
    </div>
  );
}
```

- [ ] **Step 2: Style the action variant**

`packages/admin/src/styles.css:139` — add a rule after `.error-banner`:

```css
.error-banner--act { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.error-banner--act .btn { margin-left: auto; flex: 0 0 auto; min-height: 36px; }
```

- [ ] **Step 3: Swap the six call sites**

Each is the same shape. `packages/admin/src/views/Payments.tsx:126`:

```tsx
      {list.error && <div className="error-banner">{list.error}</div>}
```
→
```tsx
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
```

`Dashboard.tsx` — `:46` currently destructures without `reload`; change it to `const { data, loading, error, reload } = useAsync(...)` and `:56`:

```tsx
      {error && <ErrorNote message={error} onRetry={reload} />}
```

`Manage.tsx:33` (Users), `:109` (Subscriptions), `:195` (Plans):

```tsx
      {error && <ErrorNote message={error} onRetry={reload} />}
```

`Manage.tsx:292` (ChannelTags) keeps its two-source message:

```tsx
      {(error || actErr) && <ErrorNote message={(error || actErr)!} onRetry={reload} />}
```

`Settings.tsx:85` — add `reload` to the destructure, and `:152`:

```tsx
  if (error) return <ErrorNote message={error} onRetry={reload} />;
```

Add `ErrorNote` to each file's `../ui` import. Leave the inline `{err && <div className="error-banner">…}` blocks inside modals alone — those report a failed *action*, not a failed load, and retrying is the button the admin already has.

- [ ] **Step 4: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
```

Create `$SCRATCH/ux44/errui.mjs` — same driver, but with a stub that fails:

```js
import { launch, sleep } from "../mob-lib.mjs";
const { send, ev } = await launch();
// fail every admin GET once, then succeed, so 重試 can be observed working
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  let failed = false;
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  window.fetch = async (u) => {
    const url = String(u && u.url ? u.url : u);
    if (!failed) { failed = true; return json({ error: "伺服器忙碌中，請稍後再試" }, 500); }
    if (url.includes("/workspace")) return json({ workspace: { billing_day: 1, settings: { overdue_days: 7, proof_retention_months: 3, admin_discord_ids: [] } }, r2_configured: true });
    if (url.includes("/users")) return json({ users: [] });
    return json({ payments: [], plans: [], subscriptions: [], channel_tags: [] });
  };
  try { localStorage.setItem("chippot.r2NoticeSeen", "1"); } catch {}
})();` });
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#users` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".error-banner")`)) break; }
await sleep(300);
const R = {};
R.banner = await ev(`document.querySelector(".error-banner").textContent`);
R.role = await ev(`document.querySelector(".error-banner").getAttribute("role")`);
R.retryBtn = await ev(`(() => { const b = document.querySelector(".error-banner .btn");
  const r = b.getBoundingClientRect(); return b.textContent.trim() + " " + Math.round(r.width) + "x" + Math.round(r.height); })()`);
await ev(`document.querySelector(".error-banner .btn").click()`);
await sleep(700);
R.bannerGone = await ev(`!document.querySelector(".error-banner")`);
console.log(JSON.stringify(R, null, 1));
process.exit(0);
```

```bash
"$SCRATCH/ux44/run.sh" t15
node "$SCRATCH/ux44/errui.mjs" > "$SCRATCH/ux44/t15/errui.json" && cat "$SCRATCH/ux44/t15/errui.json"
```

Expected: the banner shows the message plus a 重試 button ≥36px tall, `role "alert"`, and clicking it clears the banner (`bannerGone true`). Baseline: a bare red line with nothing to click.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/ui.tsx packages/admin/src/styles.css packages/admin/src/views/Payments.tsx packages/admin/src/views/Dashboard.tsx packages/admin/src/views/Manage.tsx packages/admin/src/views/Settings.tsx
git commit -m "feat(admin): 載入失敗給得出下一步（B13）

useAsync 一直有 reload 但沒有任何 error UI 用它。新增 ErrorNote：一般錯誤給「重試」（呼叫 reload），
401/403 的「請重新登入」給「重新登入」（Cloudflare Access 只在整頁重載時重發 session）。
六個載入型錯誤橫幅換用它；modal 內的動作型錯誤維持原樣。"
```

---

## Task 16: B14 — the subscription form stops teaching formats through placeholders

**Files:**
- Modify: `packages/admin/src/views/Manage.tsx` — `SubAddModal:158`, `SubEditModal:175-179`

**Interfaces:**
- Consumes: Task 8's 16px controls (so the new date pickers are already zoom-safe).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Start date becomes a real date input**

`Manage.tsx:158`:

```tsx
      <Field label="起算日 (YYYY-MM-DD)"><input value={f.start_date} onChange={(e) => set("start_date", e.target.value)} placeholder="2026-05-01" disabled={busy} /></Field>
```
→
```tsx
      {/* type=date, not a bare text box with a placeholder: everywhere else in the app a date is
          picked (Settings and the payment modals all use type="month"). */}
      <Field label="起算日"><input type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
```

- [ ] **Step 2: Same in the edit modal, plus the missing billing-day bounds and the custom-cycle consequence**

`Manage.tsx:175-179`:

```tsx
      <Field label="起算日"><input value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
      <Field label="結帳日 (1-28)"><input type="number" value={f.billing_day} onChange={(e) => set("billing_day", e.target.value)} disabled={busy} /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input type="checkbox" checked={!!f.custom_cycle} onChange={(e) => set("custom_cycle", e.target.checked ? 1 : 0)} disabled={busy} /> 自訂週期（不對齊統一結帳日）
      </label>
```
→
```tsx
      <Field label="起算日"><input type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
      <Field label="結帳日 (1-28)">
        <span className="field__hint">每月幾號為這個訂閱結帳。29–31 在短月會落空，所以上限是 28。</span>
        <input type="number" min={1} max={28} value={f.billing_day} onChange={(e) => set("billing_day", e.target.value)} disabled={busy} />
      </Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <input type="checkbox" checked={!!f.custom_cycle} onChange={(e) => set("custom_cycle", e.target.checked ? 1 : 0)} disabled={busy} /> 自訂週期（不對齊統一結帳日）
      </label>
      <span className="field__hint" style={{ marginBottom: 14 }}>
        勾選後這個訂閱依自己的結帳日出帳，不跟著工作區的統一結帳日；排程只會在該日產生它的帳單。
      </span>
```

- [ ] **Step 3: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
"$SCRATCH/ux44/run.sh" t16
O="$SCRATCH/ux44/t16" node -e '
const a=require(process.env.O+"/admin.json");
const s=a["subs+add-modal@375"];
console.log("sub-add zoomy:", JSON.stringify(s.m.zoomy));
console.log("sub-add unlabeled:", JSON.stringify(s.a.unlabeled));
console.log("overflow:", s.m.pageOverflow.overflows, "| taps<24:", s.m.taps.length);
'
```

Expected: `zoomy` empty, `unlabeled` empty, no overflow, no sub-24px targets. Then confirm the input types by hand:

Create `$SCRATCH/ux44/subform.mjs`:

```js
import { launch, sleep, ADMIN_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: ADMIN_STUB });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("chippot.r2NoticeSeen","1")}catch{}` });
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url: `http://localhost:5461/?r=${Date.now()}#subscriptions` });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector("table tbody tr")`)) break; }
await sleep(400);
await ev(`[...document.querySelectorAll("td.right .btn")].find(b=>b.textContent.trim()==="編輯").click()`);
for (let i=0;i<40;i++){ await sleep(150); if (await ev(`!!document.querySelector(".modal")`)) break; }
await sleep(300);
console.log(await ev(`[...document.querySelectorAll(".modal input")].map(i => i.type + " min=" + (i.min||"-") + " max=" + (i.max||"-"))`));
process.exit(0);
```

```bash
node "$SCRATCH/ux44/subform.mjs" | tee "$SCRATCH/ux44/t16/subform.txt"
```

Expected: `["date min=- max=-", "number min=1 max=28", "checkbox min=- max=-"]`.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Manage.tsx
git commit -m "fix(admin): 訂閱表單改用日期選擇器並補上結帳日範圍與自訂週期說明（B14）

起算日由靠 placeholder 教格式的純文字 input 改 type=date（他處一律 type=month）；
編輯 modal 的結帳日補 min=1 max=28；自訂週期補一行後果說明。"
```

---

## Task 17: B1 — the member page's 繳費渠道 picker stops being an unstyled 152×19 browser default

**Files:**
- Modify: `packages/web/src/styles.css` (add `.field`, `.field__label`, `.field select` — none of them exist)

**Interfaces:**
- Consumes: Task 7's `--line-strong` and `--muted` (both already added to `packages/web/src/styles.css`'s `:root`), Task 8's 16px rule for `.note`.
- Produces: nothing other tasks depend on.

**The defect:** `packages/web/src/App.tsx:111-123` renders `<label className="field"><span className="field__label">繳費渠道</span><select>`. `.field` and `.field__label` are **admin-only** classes (`admin/styles.css:109-114`) and nothing in `web/styles.css` styles a bare `select`, so the control measures 152×19px at 13.33px — the browser default — sitting between a 291×173 styled `.drop` and a 291×54 styled `.submit`. This is the single most visible defect on the one page members actually open. The markup does not change; only CSS is added.

- [ ] **Step 1: Add the missing rules**

Insert into `packages/web/src/styles.css` immediately before the `.drop` rule at `:131`:

```css
/* .field / .field__label are admin classes that web never had — App.tsx:111-123 has always used
   them, so the 繳費渠道 picker rendered as a 152×19px browser default at 13.3px next to a fully
   styled drop zone and submit button. Sized to match .note and .submit: 16px (no iOS auto-zoom),
   ≥48px tall for a thumb, --line-strong border for WCAG 1.4.11. Native appearance is kept, so
   iOS still draws its own chevron. */
.field { display: block; }
.field__label {
  display: block; font-size: 12px; letter-spacing: 2px;
  color: var(--muted); margin-bottom: 8px;
}
.field select {
  width: 100%; min-height: 48px; padding: 12px 14px;
  font-family: inherit; font-size: 16px; color: var(--ink);
  background: #fffdf8;
  border: 1.5px solid var(--line-strong); border-radius: 12px;
  cursor: pointer;
}
.field select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 2: Typecheck, build**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/web typecheck && VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build
```

- [ ] **Step 3: Probe the member page**

```bash
"$SCRATCH/ux44/run.sh" t17
O="$SCRATCH/ux44/t17" node -e '
const w=require(process.env.O+"/web.json");
console.log(JSON.stringify(w, null, 1).slice(0, 4000));
'
```

Then measure the select specifically. Create `$SCRATCH/ux44/webselect.mjs`:

```js
import { writeFileSync } from "node:fs";
import { launch, sleep, WEB_STUB } from "../mob-lib.mjs";
const { send, ev } = await launch();
await send("Page.addScriptToEvaluateOnNewDocument", { source: WEB_STUB });
for (const w of [375, 720]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 812, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `http://localhost:5462/u/abcdef0123456789abcd?r=${Date.now()}` });
  for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".field select")`)) break; }
  await sleep(400);
  console.log(w, await ev(`(() => { const s = document.querySelector(".field select"), cs = getComputedStyle(s);
    const r = s.getBoundingClientRect(), de = document.documentElement;
    return { size: Math.round(r.width) + "x" + Math.round(r.height), fs: cs.fontSize, border: cs.borderColor,
      labelled: !!s.closest("label"), pageOverflow: de.scrollWidth > de.clientWidth + 1,
      safeAreaPad: getComputedStyle(document.querySelector(".wrap")).paddingBottom }; })()`));
}
// PR screenshot, same session
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await send("Page.navigate", { url: "http://localhost:5462/u/abcdef0123456789abcd" });
for (let i=0;i<70;i++){ await sleep(150); if (await ev(`!!document.querySelector(".field select")`)) break; }
await sleep(600);
const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(new URL("./t17/member-375.png", import.meta.url), Buffer.from(data, "base64"));
process.exit(0);
```

```bash
node "$SCRATCH/ux44/webselect.mjs" | tee "$SCRATCH/ux44/t17/webselect.txt"
```

Expected at 375: roughly `291x48` (was `152x19`), `fs "16px"` (was `13.33px`), border resolving to `rgb(148, 136, 113)`, `labelled true`, `pageOverflow false`, and `.wrap`'s bottom padding still carrying the safe-area inset (don't-break #4).

- [ ] **Step 4: Check the screenshot for the PR**

`webselect.mjs` already wrote `$SCRATCH/ux44/t17/member-375.png`. Open it and confirm the picker now reads as part of the same design as the drop zone and the submit button — same corner radius, same border weight, same text size — rather than a browser default wedged between them. Attach it to the PR.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/styles.css
git commit -m "fix(web): 成員繳費頁的渠道選擇器補樣式（B1）

.field / .field__label 一直是 admin-only 類別，web 沒有，select 也沒有任何規則，
所以 App.tsx:111-123 的 繳費渠道 一直是 152×19px／13.3px 的瀏覽器預設，
夾在 291×173 的 .drop 與 291×54 的 .submit 中間。補上後 291×48／16px／--line-strong 邊框。"
```

---

## Task 18: B21 — remove the dead and undefined CSS

**Files:**
- Modify: `packages/admin/src/views/Settings.tsx:288,298,410,459,478,497` (drop `btn--sm`)
- Modify: `packages/web/src/styles.css:119-129` (delete the `.plans*` block)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**The `.btn--sm` decision — remove the usages, do not define the class.** It is used seven times in `Settings.tsx` and defined nowhere, so those buttons currently render full size. Defining it would *shrink* seven action-row buttons, undoing Task 11's tap-target work on the one page full of one-off admin actions. Removing the class instead keeps the rendered result byte-identical and takes the trap out of the file. (Two of the seven sites also carry `btn--danger` — leave that class exactly where it is, it belongs to batch A.)

- [ ] **Step 1: Drop the seven `btn--sm` occurrences**

In `packages/admin/src/views/Settings.tsx`:

- `:288` `className="btn btn--sm"` → `className="btn"` (送出測試)
- `:298` `className="btn btn--sm btn--danger"` → `className="btn btn--danger"` (匯入…)
- `:410` `className="btn btn--sm btn--danger"` → `className="btn btn--danger"` (發起繳費…)
- `:459` `className="btn btn--sm"` → `className="btn"` (重建)
- `:478` `className="btn btn--sm"` → `className="btn"` (張貼／更新)
- `:497` `className="btn btn--sm"` → `className="btn"` (註冊)

Verify the count is zero afterwards:

```bash
grep -rn "btn--sm" packages/ || echo "no btn--sm left"
```

(If batch A has already rewritten the 發起繳費 / 匯入 rows, apply this to whatever `btn--sm` sites remain — the rule is simply "the class is undefined, so it must not appear".)

- [ ] **Step 2: Delete the dead `.plans*` block**

`packages/web/src/styles.css:119-129` — remove entirely:

```css
.plans { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.plans legend { font-size: 12px; letter-spacing: 2px; color: var(--muted); margin-bottom: 8px; }
.plan {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border: 1.5px solid var(--line); border-radius: 12px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.plan input { accent-color: var(--accent); }
.plan--on { border-color: var(--accent); background: rgba(15, 110, 99, 0.05); }
.plan__name { flex: 1; font-weight: 500; }
.plan__amt { font-family: "Spline Sans Mono", monospace; color: var(--muted); }
```

No `.plans` / `.plan` element is ever rendered — the probe confirmed it; the markup is left over from a design where members picked plans. Confirm before deleting:

```bash
grep -rn "className=\"plan\|plans\|plan__\|plan--" packages/web/src || echo "confirmed dead"
```

Note `mob-lib.mjs`'s `MEASURE` selector list includes `label.plan`; leave the harness alone, an absent selector simply matches nothing.

- [ ] **Step 3: Typecheck, build, probe**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm --filter @chippot/admin typecheck && pnpm --filter @chippot/admin build
pnpm --filter @chippot/web typecheck && VITE_API_BASE=https://example.workers.dev pnpm --filter @chippot/web build
"$SCRATCH/ux44/run.sh" t18
O="$SCRATCH/ux44/t18" node -e '
const a=require(process.env.O+"/admin.json");
const s=a["settings@375"], s2=a["settings@1280"];
console.log("settings@375 taps<24:", JSON.stringify(s.m.taps));
console.log("settings@1280 taps<24:", JSON.stringify(s2.m.taps));
console.log("overflow:", Object.entries(a).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).map(([k])=>k));
'
```

Expected: no new small targets on Settings at either width (removing an undefined class must not change any measurement — that is the point); zero overflow.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/views/Settings.tsx packages/web/src/styles.css
git commit -m "chore: 清掉死的與未定義的 CSS（B21）

.btn--sm 用了七次卻從未定義（目前反而讓按鈕維持全尺寸）→ 移除用法而非補定義，
補定義會把設定頁七顆一次性動作鈕縮小，跟 B17 的觸控目標相衝。
web/styles.css 的 .plans/.plan* 整段是死的（頁面從不 render 這些元素）→ 刪除。
Manage.tsx:21 的 var(--danger) 屬批次 A，未動。"
```

---

## Task 19: Rebase, full regression sweep, PR

**Files:**
- Modify: none (verification and PR only)

**Interfaces:**
- Consumes: every previous task.
- Produces: the PR body's before/after table.

- [ ] **Step 1: Rebase onto post-A `main`**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git fetch origin
git rebase origin/main
```

If Tasks 12 or 13 conflict (they will if batch A landed), resolve toward **A's version of every button, label, handler and colour** and re-apply only this batch's structural wrappers: `<div className="toolbar__acts">` around whatever one-off actions the toolbar ends up with, and `.tbl-cards` + `data-label` + `.tbl--pin-last` on the push-status table. Re-run Task 12 Step 3 and Task 13 Step 2 afterwards and confirm their acceptance numbers still hold.

- [ ] **Step 2: Full build and worker suite**

```bash
pnpm -r typecheck
pnpm -r build   # web's build needs VITE_API_BASE; export it first if the root build trips
pnpm -r test
```

Expected: typecheck and build clean; `pnpm -r test` reports the same count as Task 1 Step 6 (243) with zero failures. If the number moved, something in this batch reached into `packages/worker` — find it and revert it.

- [ ] **Step 3: Final probe sweep**

```bash
"$SCRATCH/ux44/run.sh" final
node "$SCRATCH/ux44/wide.mjs"   > "$SCRATCH/ux44/final/wide.json"
node "$SCRATCH/ux44/tabs.mjs"   > "$SCRATCH/ux44/final/tabs.json"
node "$SCRATCH/ux44/rowkb.mjs"  > "$SCRATCH/ux44/final/rowkb.json"
node "$SCRATCH/ux44/filter.mjs" > "$SCRATCH/ux44/final/filter.json"
```

- [ ] **Step 4: Produce the before/after table**

```bash
S="$SCRATCH" node -e '
const L=(l,f)=>require(process.env.S+"/ux44/"+l+"/"+f);
const bA=L("baseline","admin.json"), fA=L("final","admin.json");
const bF=L("baseline","focus.json"), fF=L("final","focus.json");
const bB=L("baseline","boundary.json"), fB=L("final","boundary.json");
const row=(k,b,a)=>console.log("| "+k.padEnd(46)+" | "+String(b).padEnd(22)+" | "+a+" |");
const ovf=(x)=>Object.entries(x).filter(([k,v])=>v.m&&v.m.pageOverflow.overflows).length;
const taps=(x)=>Object.entries(x).filter(([k])=>/@375$|@720$/.test(k)).reduce((n,[,v])=>n+(v.m?v.m.taps.length:0),0);
const unl=(x)=>Object.entries(x).reduce((n,[,v])=>n+(v.a?v.a.unlabeled.length:0),0);
console.log("| 指標 | before | after |"); console.log("|---|---|---|");
for (const v of ["users","subscriptions","plans","tags","dashboard"])
  row("列動作在畫面外 @375 · "+v, bF["actions_"+v].offscreenCount+"/"+bF["actions_"+v].n, fF["actions_"+v].offscreenCount+"/"+fF["actions_"+v].n);
for (const w of [721,768,844,932]) row("死區 "+w+"px · payments 動作", bB[w].payments.rowActionsOffscreen, fB[w].payments.rowActionsOffscreen);
row("繳費工具列高度 @375", bF.paymentsToolbar.toolbarH+"px", fF.paymentsToolbar.toolbarH+"px");
row("首屏可見繳費列數 @375", bF.paymentsToolbar.rowsAboveFold, fF.paymentsToolbar.rowsAboveFold);
row("Modal role/aria-modal", "null / null", "dialog / true");
row("Modal 開啟後焦點在內", bA["users+edit-modal@375"].a.dialog.activeInsideModal, fA["users+edit-modal@375"].a.dialog.activeInsideModal);
row("Escape 關得掉 modal", bF.modalOpenAfterEscape===false, fF.modalOpenAfterEscape===false);
row("背景捲動鎖 body overflow", bF.bodyLock.bodyOverflow, fF.bodyLock.bodyOverflow);
row("Tab 停在 modal 內 (12 次)", (12-bF.tabWalkInModal.filter(s=>/OUTSIDE/.test(s)).length)+"/12", (12-fF.tabWalkInModal.filter(s=>/OUTSIDE/.test(s)).length)+"/12");
row("無可及名稱的輸入框", unl(bA), unl(fA));
row("低於 24px 的觸控目標 @375/720", taps(bA), taps(fA));
row("低於 16px 的表單控件", Object.entries(bA).reduce((n,[,v])=>n+(v.m?v.m.zoomy.length:0),0), Object.entries(fA).reduce((n,[,v])=>n+(v.m?v.m.zoomy.length:0),0));
row("橫向頁面溢出（51 組合）", ovf(bA), ovf(fA));
row("savebar 遮住的控件", JSON.stringify(bF.settingsBottom.blockedAtBottom), JSON.stringify(fF.settingsBottom.blockedAtBottom));
' | tee "$SCRATCH/ux44/final/table.md"
echo; echo "contrast:"; tail -2 "$SCRATCH/ux44/baseline/contrast.txt"; tail -2 "$SCRATCH/ux44/final/contrast.txt"
```

Expected shape: every "off-screen" row `N/N → 0/N`; toolbar `183px → ≤130px`; rows above fold `2 → ≥3`; modal row `null → dialog`; Escape `false → true`; body overflow `visible → hidden`; Tab `0/12 → 12/12`; unlabeled `3 → 0`; sub-24px `>0 → 0`; sub-16px `>0 → 0`; **overflow `0 → 0`** and **savebar `[] → []`** (the two don't-break invariants).

- [ ] **Step 5: Confirm the don't-break list one final time**

```bash
S="$SCRATCH" node -e '
const f=require(process.env.S+"/ux44/final/focus.json"), a=require(process.env.S+"/ux44/final/admin.json"), w=require(process.env.S+"/ux44/final/web.json");
console.log("1 overflow:", Object.entries(a).filter(([k,v])=>v.m&&(v.m.pageOverflow.overflows||v.m.bleeders.length)).map(([k])=>k));
console.log("2 savebar:", JSON.stringify(f.settingsBottom.blockedAtBottom), f.settingsBottom.settingsPadBottom);
console.log("3 sheets:", Object.keys(a).filter(k=>/-modal@375$/.test(k)).map(k=>k+" "+a[k].extra.backdrop.placeItems).join(" | "));
console.log("4 safe area:", JSON.stringify(w.geo || w).slice(0,200));
console.log("5 mreview:", f.memberReview.back, JSON.stringify(f.memberReview.btns.slice(0,3)), "sameRow", f.memberReviewReject.sameRow);
console.log("6 stat bleeders:", JSON.stringify(a["dashboard@375"].m.bleeders));
'
```

All six must read as described in the Global Constraints table. If any regressed, fix it before opening the PR — do not open a PR with a broken invariant and a note.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin ux/44-mobile-a11y
gh pr create --title "[UX-B] 行動版收尾與可及性（P0-9 / P0-10 ＋ B1–B21）" --body-file - <<'BODY'
UX 健檢批次 B，純前端。worker 未動，測試維持 243 passed。

## 做了什麼

**P0-9** Manage 四表（成員／訂閱／方案／支付渠道）延伸 `.tbl-cards`，每個 `td` 補 `data-label`。
**P0-10** 行動版斷點 720px → 1000px、行動版改 block flow；1000px 以上的寬表格改用 sticky 首欄／動作欄，
所以「動作鈕從畫面外開始」在**任何**寬度都不再發生（單純提高斷點只會把死區搬到 1001–1346px）。

B1 成員頁渠道 select 補樣式 · B2 表單 16px · B3 分頁條 sticky＋自動捲到目前分頁＋邊緣漸層 ·
B4/B5/B16 Modal dialog 語意＋焦點 trap＋Escape＋背景捲動鎖 · B6/B7/B18＋X3 對比與焦點指示 ·
B8 設定頁三個輸入補可及名稱 · B9 繳費工具列瘦身 · B10 看板推播狀態卡片化、各方案首欄 sticky ·
B11 繳費列鍵盤可操作 · B12 名單搜尋（借 Discord >25 降級思路）· B13 載入失敗給重試／重新登入 ·
B14 訂閱表單日期選擇器與範圍 · B15 橫向捲動邊緣提示 · B17 小觸控目標四處 · B19 `.content` 1100 → 1180 ·
B20 header landmark／表格 caption＋th[scope]／成員頁 h1-h2／.note 可及名稱 · B21 死 CSS 清除。

## 量測（CDP，稽核同一套 harness）

<!-- paste $SCRATCH/ux44/final/table.md here -->

對比：15/34 FAIL → 2/36 FAIL（僅剩 owner 決定保留的 `--line` 卡片邊框）。

## owner 決策遵守情形

`--line` 紙感保留；只有 `input` / `textarea` / `select` 的邊框改為 `--line-strong #948871`（3.43:1）。
卡片、表格、topbar 邊框一律未動。

## 不在這個 PR

`--danger` / `.btn--danger` 的整併與 `Manage.tsx:21` 屬批次 A（#43）。
`/payments` 沒有 `LIMIT`、表格排序屬批次 E（worker 變更）。
Manage 四張卡片標題改為「…名單／清單」是為了拆掉重複的 H1/H2，請批次 D 保留。

Closes #44
BODY
```

- [ ] **Step 7: Paste the measurement table into the PR body**

```bash
gh pr view --json body -q .body > /tmp/pr.md
# replace the "<!-- paste ... -->" line with the contents of $SCRATCH/ux44/final/table.md, then:
gh pr edit --body-file /tmp/pr.md
```

- [ ] **Step 8: Stop the dev servers and report**

```bash
"$SCRATCH/ux44/stop.sh"
```

Report to the requesting agent: PR URL, the before/after table, the worker test count (unchanged), and the six don't-break checks with their final values.

---

## Spec coverage map

| Spec item | Task |
|---|---|
| P0-9 Manage 四表 `.tbl-cards` + `data-label` | 2 |
| P0-10 breakpoint → 1000px, regression at 1024/1280 | 3 (breakpoint), 4 (1024/1280 via sticky columns), 19 (final sweep) |
| B1 member-page select unstyled | 17 |
| B2 14px → 16px | 8 |
| B3 tab strip hidden / static | 5 |
| B4 modal dialog semantics + focus | 6 |
| B5 Escape | 6 |
| B6 focus ring contrast + missing `:focus-visible` | 7 |
| B7 `--muted` under 4.5:1 in six places | 7 |
| B8 three Settings inputs unnamed | 9 |
| B9 payments toolbar 183px | 12 ⚠️ |
| B10 dashboard sticky first column + 重置 off-screen | 4 (sticky), 13 ⚠️ (push-status card) |
| B11 `tr.click` not keyboard-operable | 10 |
| B12 no roster search | 14 (frontend; `/payments` LIMIT stays with E) |
| B13 no error UI uses `reload` | 15 |
| B14 subscription form input types / bounds / hint | 16 |
| B15 no scroll affordance | 4 (`.tbl`), 5 (`.sidebar`), 12 (`.pills` / `.toolbar__acts`) |
| B16 no body scroll lock | 6 |
| B17 four small tap targets | 11 |
| B18 amber / tag / badge / chip / sidebar-foot contrast | 7 |
| B19 payments table scrolls at 1280 | 4 |
| B20 semantics (header, captions, headings, `.note`, dead branch) | 9 |
| B21 `.btn--sm` undefined, `.plans*` dead | 18 |
| X3 form-field borders ≥3:1 (owner-scoped) | 7 |
| Verification harness reuse, baselines, regression sweep | 1, 19 |

**Deliberately excluded** (stated so a reviewer does not read them as gaps): `--danger` consolidation and `Manage.tsx:21` (batch A); `/payments` `LIMIT` and table sorting (batch E, worker change); `.drop`'s dashed border (outside the owner's `input/textarea/select` scope); the two remaining `--line` contrast failures (owner decision to keep the paper aesthetic).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-31-ux-b-mobile-a11y.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: `superpowers:executing-plans`.

Tasks 1→4 are strictly ordered (2 before 3 before 4). Tasks 5–11 and 14–18 are independent of each other once 3 and 4 have landed, but they all edit `styles.css`, so run them sequentially rather than in parallel. Tasks 12 and 13 must wait until batch A (#43) has merged. Task 19 is last.
