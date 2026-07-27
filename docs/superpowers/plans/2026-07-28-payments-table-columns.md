# 繳費審核表格欄位調整 Implementation Plan (issue #29)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the admin 繳費審核 table, show 申報渠道 as a column, drop the 來源 column, and hide the 憑證 column entirely when R2 is not configured — so an admin reconciling payments sees the field they actually need without opening each row.

**Architecture:** Front-end only, one file. `packages/admin/src/views/Payments.tsx` already fetches `api.workspace()` (for `billing_day`) and the list rows already carry `declared_channel_tag_name` from `GET /admin/payments` — so no worker, API, schema, or type changes are needed. The 憑證 column becomes conditional on `r2_configured !== false`, and the loading/empty-row `colSpan` is derived from a single module constant plus that flag instead of being a hardcoded `8`, so the two can never drift apart.

**Tech Stack:** React 18 + TypeScript + Vite (`packages/admin`), hand-written `styles.css` (no Tailwind, no CSS-in-JS), pnpm workspaces.

**Branch:** `feat/29-payments-table-columns` (branch off `main`). The PR body MUST contain `Closes #29`.

## Global Constraints

- Implement exactly the spec in "Scope" below — no more. YAGNI: no refactors, no new abstractions, no drive-by cleanups in files you touch.
- **Owner explicitly rejected user-configurable columns.** Do NOT build any column-preference UI, localStorage toggle, or settings entry, even though issue #29 mentions it as an option.
- UI copy is Traditional Chinese (zh-TW). **Code comments in `packages/admin` are written in English** — match the file (see the existing comments at `packages/admin/src/views/Payments.tsx:13`, `:24`, `:37-39`).
- Follow existing repo conventions: inline JSX table markup, `className="right"` for right-aligned cells, `className="mono"` for monospace, muted em-dash placeholder `<span style={{ color: "var(--muted)" }}>—</span>`.
- **NEVER modify `packages/worker/wrangler.toml`** (it is `skip-worktree`'d locally and holds the owner's real values).
- No worker-side changes at all. `declared_channel_tag_name` is already selected in `listPayments` (`packages/worker/src/routes/admin.ts:504-511`) and already typed client-side (`packages/admin/src/api.ts:28`). Verified 2026-07-28.
- **`packages/admin` has no test framework and you must not add one.** Evidence: `packages/admin/package.json` scripts are only `dev` / `build` / `preview` / `typecheck`; the only `vitest.config.ts` in the repo is `packages/worker/vitest.config.ts`; `testing-library` appears 0 times in `pnpm-lock.yaml`. Adding vitest + jsdom + @testing-library to the admin package is out of scope for this issue. The per-task verification cycle is therefore: a framework-free structural assertion (`grep`) that fails before the change and passes after, then `tsc --noEmit`, then `vite build` — plus one manual browser check in Task 2.
- The worker Vitest suite must stay green and unchanged in count (baseline **243 passed**, recorded in `README.md:12` and the last `docs/deploy-state.md` entry). This plan adds no worker tests.
- Conventional commits, matching `git log` style; zh-TW allowed in the subject (e.g. `fix(admin): unbind by clearing Discord ID now works`, `feat(discord): >25 人名單的綁定搜尋`).

## Scope (locked with the owner)

1. ADD a 申報渠道 column rendering `payment.declared_channel_tag_name`.
2. REMOVE the 來源 column from the table. The detail modal must KEEP showing source info — it already does (`<dt>來源</dt><dd>{payment.source}</dd>`), so this is a verification, not an edit.
3. HIDE the 憑證 column entirely when `workspace.r2_configured === false`.
4. Final column order: 成員 | 方案 | 期別 | 金額 | 狀態 | 申報渠道 | 憑證 (only when R2 on) | (actions). Keep existing alignment conventions (金額 right-aligned, actions right-aligned, everything else default left).
5. `colSpan` on the loading and empty rows must match the actual rendered column count in **both** R2-on (8) and R2-off (7) cases.

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `packages/admin/src/views/Payments.tsx` | Modify (only file with code changes) | Holds the payments list table (`Payments`), the reconcile modal (`SyncModal`), row quick-verify (`QuickVerify`), and the review modal (`PaymentDetail`). Task 1 edits the `<thead>`/`<tbody>` cells; Task 2 adds one module constant + two derived values near the top of `Payments`. |
| `docs/deploy-state.md` | Modify (append one section at the end, Task 3) | Running zh-TW log of shipped changes, one `## <描述> (PR #NN, YYYY-MM-DD)` section per PR, appended at the bottom. |

Explicitly NOT touched: `packages/admin/src/api.ts` (the `Payment` type already has `declared_channel_tag_name: string | null`), `packages/admin/src/styles.css` (no new classes needed — reuse `.right` / `var(--muted)`), `packages/admin/src/App.tsx`, anything under `packages/worker`, `README.md` (it does not document the payments table columns — grepped 2026-07-28).

## Quality gates (CI parity)

`.github/workflows/ci.yml` runs, in order: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` (with `VITE_API_BASE` set), then a guard asserting `@chippot/web` **fails** to build without `VITE_API_BASE`. Reproduce locally before pushing:

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm -r typecheck
pnpm -r test
VITE_API_BASE=https://example.invalid pnpm -r build
```

Per-task, the fast gates are:

```bash
pnpm --filter @chippot/admin typecheck   # tsc --noEmit
pnpm --filter @chippot/admin build       # vite build
```

The tasks below also write two throwaway assertion scripts to `/tmp`. If your session has a scratchpad directory, put them there instead — the only hard rule is that they stay outside the repo so they can never be committed.

---

### Task 1: Swap the 來源 column for 申報渠道

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx:79` (thead), `:83-99` (row cells)
- Verify only, do not edit: `packages/admin/src/views/Payments.tsx:230` (`<dt>來源</dt>` in `PaymentDetail`)
- Test: none — `@chippot/admin` has no test framework (see Global Constraints). Verification is the grep assertions + `typecheck` + `build` in the steps below.

**Interfaces:**
- Consumes: `Payment` from `packages/admin/src/api.ts:24-31` — the fields used here are `declared_channel_tag_name: string | null` and `source: string`. No signature changes.
- Produces: a 8-column table whose column order is 成員 | 方案 | 期別 | 金額 | 狀態 | 申報渠道 | 憑證 | (actions). Task 2 makes the 憑證 column conditional and replaces the `colSpan={8}` literals; it depends on this exact order.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
git checkout main
git pull --ff-only
git checkout -b feat/29-payments-table-columns
```

- [ ] **Step 2: Record the baseline gate results**

```bash
pnpm -r typecheck
pnpm -r test
```
Expected: typecheck clean; worker suite **243 passed** (0 failed). Write the number down — Task 3 asserts it is unchanged. If your baseline differs from 243 because another PR landed first, that newer number is your baseline; what matters is 0 failed and no change caused by this branch.

- [ ] **Step 3: Write the failing structural assertion**

There is no admin test runner, so the executable check for this task is a shell assertion over the source. Save it as a scratch file (do NOT commit it):

```bash
cat > /tmp/assert-task1.sh <<'EOF'
#!/bin/bash
# Task 1 spec assertions for packages/admin/src/views/Payments.tsx
set -u
F=packages/admin/src/views/Payments.tsx
fail=0

# 1. the table header must no longer carry a 來源 column
if grep -q '<th>來源</th>' "$F"; then echo "FAIL: <th>來源</th> still in thead"; fail=1
else echo "ok: no <th>來源</th>"; fi

# 2. the raw source value must no longer be rendered as a row cell
if grep -q '{p.source}' "$F"; then echo "FAIL: {p.source} still rendered in a row"; fail=1
else echo "ok: no {p.source} row cell"; fi

# 3. the header must carry a 申報渠道 column
if grep -q '<th>申報渠道</th>' "$F"; then echo "ok: <th>申報渠道</th> present"
else echo "FAIL: <th>申報渠道</th> missing"; fail=1; fi

# 4. rows must render the declared channel name
if grep -q 'p.declared_channel_tag_name' "$F"; then echo "ok: row renders declared_channel_tag_name"
else echo "FAIL: rows do not render declared_channel_tag_name"; fail=1; fi

# 5. REGRESSION GUARD: the detail modal must keep showing source info
if grep -q '<dt>來源</dt><dd>{payment.source}</dd>' "$F"; then echo "ok: modal still shows 來源"
else echo "FAIL: modal lost the 來源 row"; fail=1; fi

exit $fail
EOF
chmod +x /tmp/assert-task1.sh
```

- [ ] **Step 4: Run the assertion to verify it fails**

```bash
bash /tmp/assert-task1.sh; echo "exit=$?"
```
Expected on current `main`: `FAIL: <th>來源</th> still in thead`, `FAIL: {p.source} still rendered in a row`, `FAIL: <th>申報渠道</th> missing`, `FAIL: rows do not render declared_channel_tag_name`, `ok: modal still shows 來源`, `exit=1`.

- [ ] **Step 5: Replace the header row**

In `packages/admin/src/views/Payments.tsx`, replace the single `<thead>` line (currently line 79):

```tsx
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>憑證</th><th>來源</th><th></th></tr></thead>
```

with:

```tsx
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>申報渠道</th><th>憑證</th><th></th></tr></thead>
```

(申報渠道 moves in front of 憑證, and 來源 is gone. Column count stays 8, so the `colSpan={8}` literals on lines 81-82 are still correct after this task; Task 2 changes them.)

- [ ] **Step 6: Add the 申報渠道 cell and delete the 來源 cell**

In the same file, the row body currently reads (lines 84-99):

```tsx
                <tr key={p.id} className="click" onClick={() => setSelected(p)}>
                  <td>{p.user_name}</td>
                  <td>{p.plan_name}</td>
                  <td className="mono">{p.period}</td>
                  <td className="right"><Money v={p.amount} /></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>{
                    ["paid", "verified"].includes(p.status)
                      ? (p.has_proof ? <span className="proof-yes iconlbl"><IconCheck />有截圖</span> : <span className="proof-no iconlbl"><IconWarning />純聲明</span>)
                      : <span style={{ color: "var(--muted)" }}>—</span>
                  }</td>
                  <td style={{ fontSize: 12.5, color: "var(--muted)" }}>{p.source}</td>
                  <td className="right" onClick={(e) => e.stopPropagation()}>
                    {p.status === "paid" && <QuickVerify id={p.id} onDone={reload} />}
                  </td>
                </tr>
```

Make it read:

```tsx
                <tr key={p.id} className="click" onClick={() => setSelected(p)}>
                  <td>{p.user_name}</td>
                  <td>{p.plan_name}</td>
                  <td className="mono">{p.period}</td>
                  <td className="right"><Money v={p.amount} /></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>{p.declared_channel_tag_name || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td>{
                    ["paid", "verified"].includes(p.status)
                      ? (p.has_proof ? <span className="proof-yes iconlbl"><IconCheck />有截圖</span> : <span className="proof-no iconlbl"><IconWarning />純聲明</span>)
                      : <span style={{ color: "var(--muted)" }}>—</span>
                  }</td>
                  <td className="right" onClick={(e) => e.stopPropagation()}>
                    {p.status === "paid" && <QuickVerify id={p.id} onDone={reload} />}
                  </td>
                </tr>
```

Three things changed: the 申報渠道 `<td>` is inserted between 狀態 and 憑證; the old `<td style={{ fontSize: 12.5, … }}>{p.source}</td>` line is deleted; nothing else moves. `||` (not `??`) is deliberate — it also covers an empty-string tag name, and truthiness is the convention used for the same field in the modal at line 232.

- [ ] **Step 7: Confirm the detail modal still shows 來源 (no edit expected)**

```bash
grep -n '<dt>來源</dt>' packages/admin/src/views/Payments.tsx
```
Expected: one hit, `<dt>來源</dt><dd>{payment.source}</dd>` (around line 229 after the row edits). Spec item 2 requires the source stay reachable in the modal; it already is, so **do not add a second 來源 row** and do not reformat that `<dl className="kv">` block.

- [ ] **Step 8: Run the assertion and the gates**

```bash
bash /tmp/assert-task1.sh; echo "exit=$?"
pnpm --filter @chippot/admin typecheck
pnpm --filter @chippot/admin build
```
Expected: all five assertion lines print `ok:`, `exit=0`; typecheck prints nothing (exit 0); `vite build` reports `✓ built in …` with no TypeScript or JSX errors.

- [ ] **Step 9: Commit**

```bash
git add packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): 繳費審核表格改列 申報渠道，移除 來源 欄（詳情頁仍顯示來源）"
```

---

### Task 2: Hide the 憑證 column when R2 is not configured, and derive `colSpan`

**Files:**
- Modify: `packages/admin/src/views/Payments.tsx` — add one module-level constant above `function Payments()` (near the existing `STATUS_OPTS` at lines 5-11), two derived values inside `Payments` right after `billingDay` (line 23), and use them in the `<thead>` / `colSpan` / 憑證 `<td>`
- Test: none — `@chippot/admin` has no test framework (see Global Constraints). Verification is the grep assertion + `typecheck` + `build` + the manual browser check below.

**Interfaces:**
- Consumes: `api.workspace()` from `packages/admin/src/api.ts:48`, typed `() => Promise<{ workspace: any; r2_configured: boolean }>`; wrapped by `useAsync` (`packages/admin/src/ui.tsx:3-21`) which returns `{ data: T | null; loading: boolean; error: string | null; reload: () => void }`. `Payments` already holds it as `const ws = useAsync(() => api.workspace(), []);` (line 22), so `ws.data?.r2_configured` is `boolean | undefined` with no cast needed.
- Produces: module constant `BASE_COLS: number` (= 7) and, inside `Payments`, `showProof: boolean` and `colCount: number`. `colCount` is the only value passed to `colSpan` on the loading/empty rows.

- [ ] **Step 1: Write the failing structural assertion**

Scratch file again (do NOT commit):

```bash
cat > /tmp/assert-task2.sh <<'EOF'
#!/bin/bash
# Task 2 spec assertions for packages/admin/src/views/Payments.tsx
set -u
F=packages/admin/src/views/Payments.tsx
fail=0

# 1. no hardcoded colSpan literals may remain in this file
if grep -qE 'colSpan=\{[0-9]+\}' "$F"; then echo "FAIL: hardcoded colSpan literal still present"; fail=1
else echo "ok: no hardcoded colSpan literal"; fi

# 2. both the loading and the empty row must use the derived count
n=$(grep -c 'colSpan={colCount}' "$F")
if [ "$n" = "2" ]; then echo "ok: 2 rows use colSpan={colCount}"
else echo "FAIL: expected 2 colSpan={colCount}, found $n"; fail=1; fi

# 3. the 憑證 header must be conditional on showProof
if grep -q '{showProof && <th>憑證</th>}' "$F"; then echo "ok: 憑證 header is conditional"
else echo "FAIL: 憑證 header is not gated on showProof"; fail=1; fi

# 4. the R2 flag must be read with the === false convention used in App.tsx
if grep -q 'ws.data?.r2_configured !== false' "$F"; then echo "ok: showProof derived from r2_configured"
else echo "FAIL: showProof not derived from ws.data?.r2_configured !== false"; fail=1; fi

# 5. the 憑證 body cell must be gated too (showProof must gate exactly 2 places: th + td)
n=$(grep -c 'showProof &&' "$F")
if [ "$n" = "2" ]; then echo "ok: showProof gates the header and the body cell"
else echo "FAIL: expected 2 showProof gates (th + td), found $n"; fail=1; fi

exit $fail
EOF
chmod +x /tmp/assert-task2.sh
```

- [ ] **Step 2: Run the assertion to verify it fails**

```bash
bash /tmp/assert-task2.sh; echo "exit=$?"
```
Expected after Task 1: `FAIL: hardcoded colSpan literal still present`, `FAIL: expected 2 colSpan={colCount}, found 0`, `FAIL: 憑證 header is not gated on showProof`, `FAIL: showProof not derived from ws.data?.r2_configured !== false`, `FAIL: expected 2 showProof gates (th + td), found 0`, `exit=1`.

- [ ] **Step 3: Add the `BASE_COLS` module constant**

In `packages/admin/src/views/Payments.tsx`, immediately after the `STATUS_OPTS` array (which ends with `];` on line 11) and before the `paymentIdFromHash` comment on line 13, insert:

```tsx
// Fixed table columns: 成員·方案·期別·金額·狀態·申報渠道 + the actions column. 憑證 is conditional
// (R2-only) and adds one on top — see colCount in Payments(), which every colSpan must use.
const BASE_COLS = 7;
```

- [ ] **Step 4: Derive `showProof` and `colCount`**

Inside `function Payments()`, the first two lines are currently:

```tsx
  const ws = useAsync(() => api.workspace(), []);
  const billingDay = (ws.data as any)?.workspace?.billing_day ?? 1;
```

Insert the derived values directly below them (leave the two existing lines exactly as they are — the `as any` on `billingDay` is pre-existing and out of scope):

```tsx
  // Without R2 no payment can ever have a screenshot, so the 憑證 column is dead weight — hide it.
  // Matches App.tsx's `r2_configured === false` check: while the workspace is still loading the flag
  // is undefined and we show the column (the configured case is the common one).
  const showProof = ws.data?.r2_configured !== false;
  const colCount = BASE_COLS + (showProof ? 1 : 0);
```

- [ ] **Step 5: Gate the 憑證 header and use `colCount` for both placeholder rows**

The `<thead>` and the two placeholder rows currently read (lines shift by ~7 after Steps 3-4):

```tsx
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>申報渠道</th><th>憑證</th><th></th></tr></thead>
            <tbody>
              {list.loading && <tr><td colSpan={8}><Empty>載入中…</Empty></td></tr>}
              {list.data?.payments.length === 0 && <tr><td colSpan={8}><Empty>沒有符合的紀錄</Empty></td></tr>}
```

Make them read:

```tsx
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>申報渠道</th>{showProof && <th>憑證</th>}<th></th></tr></thead>
            <tbody>
              {list.loading && <tr><td colSpan={colCount}><Empty>載入中…</Empty></td></tr>}
              {list.data?.payments.length === 0 && <tr><td colSpan={colCount}><Empty>沒有符合的紀錄</Empty></td></tr>}
```

- [ ] **Step 6: Gate the 憑證 body cell**

In the same row body, wrap the proof `<td>` (the one whose content branches on `["paid", "verified"].includes(p.status)`) in the same `showProof` gate. It currently reads:

```tsx
                  <td>{
                    ["paid", "verified"].includes(p.status)
                      ? (p.has_proof ? <span className="proof-yes iconlbl"><IconCheck />有截圖</span> : <span className="proof-no iconlbl"><IconWarning />純聲明</span>)
                      : <span style={{ color: "var(--muted)" }}>—</span>
                  }</td>
```

Make it read:

```tsx
                  {showProof && <td>{
                    ["paid", "verified"].includes(p.status)
                      ? (p.has_proof ? <span className="proof-yes iconlbl"><IconCheck />有截圖</span> : <span className="proof-no iconlbl"><IconWarning />純聲明</span>)
                      : <span style={{ color: "var(--muted)" }}>—</span>
                  }</td>}
```

For reference, the complete `<Card title="繳費紀錄">` block must now read exactly:

```tsx
      <Card title="繳費紀錄">
        <div className="tbl">
          <table>
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>申報渠道</th>{showProof && <th>憑證</th>}<th></th></tr></thead>
            <tbody>
              {list.loading && <tr><td colSpan={colCount}><Empty>載入中…</Empty></td></tr>}
              {list.data?.payments.length === 0 && <tr><td colSpan={colCount}><Empty>沒有符合的紀錄</Empty></td></tr>}
              {list.data?.payments.map((p) => (
                <tr key={p.id} className="click" onClick={() => setSelected(p)}>
                  <td>{p.user_name}</td>
                  <td>{p.plan_name}</td>
                  <td className="mono">{p.period}</td>
                  <td className="right"><Money v={p.amount} /></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>{p.declared_channel_tag_name || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  {showProof && <td>{
                    ["paid", "verified"].includes(p.status)
                      ? (p.has_proof ? <span className="proof-yes iconlbl"><IconCheck />有截圖</span> : <span className="proof-no iconlbl"><IconWarning />純聲明</span>)
                      : <span style={{ color: "var(--muted)" }}>—</span>
                  }</td>}
                  <td className="right" onClick={(e) => e.stopPropagation()}>
                    {p.status === "paid" && <QuickVerify id={p.id} onDone={reload} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
```

Count the cells against `BASE_COLS`: 成員, 方案, 期別, 金額, 狀態, 申報渠道, actions = 7 unconditional cells; 憑證 is the +1. Header `<th>`s and body `<td>`s must both be 7 (+1).

- [ ] **Step 7: Leave the detail modal's proof section alone**

Spec item 3 is about the **table column only**. `PaymentDetail` keeps its screenshot `<img>`, its 「截圖已依保存期…刪除」 note, and its 無憑證，純聲明 warning unchanged; with R2 off those rows simply never have `screenshot_key`. Read this task's diff and confirm its shape:

```bash
git diff packages/admin/src/views/Payments.tsx
```
Expected: exactly **4 hunks** — (1) the `BASE_COLS` block added after `STATUS_OPTS`, (2) the `showProof`/`colCount` block added after `billingDay`, (3) the `<thead>` line plus the two `colSpan` lines, (4) the proof `<td>` open/close lines. **No hunk may fall inside `SyncModal`, `QuickVerify`, `PaymentDetail`, `ManualModal`, or `LinkModal`.** If you see a fifth hunk or a hunk in one of those components, you changed something out of scope — revert it.

- [ ] **Step 8: Run the assertion and the gates**

```bash
bash /tmp/assert-task2.sh; echo "exit=$?"
bash /tmp/assert-task1.sh; echo "exit=$?"
pnpm --filter @chippot/admin typecheck
pnpm --filter @chippot/admin build
```
Expected: both assertion scripts print only `ok:` lines and `exit=0` (Task 1's assertions must still hold); typecheck silent; build succeeds.

- [ ] **Step 9: Manual browser check of the header in both R2 states**

`tsc` cannot catch a `<th>`/`<td>` count mismatch, and there is no component test — so eyeball the header. Note `packages/admin/vite.config.ts` has no dev proxy to the worker, so the API calls 404 against the Vite dev server: the error banner appears and the tbody stays empty, but the header renders, which is what this step checks.

```bash
pnpm --filter @chippot/admin dev
```
Open the printed URL (default `http://localhost:5173`), click 繳費審核 in the sidebar, and confirm the header reads 成員 方案 期別 金額 狀態 申報渠道 憑證 (R2-unknown default → 憑證 shown, 8 columns, 來源 gone).

Then check the R2-off case with a temporary, uncommitted stub — change the `showProof` line to:

```tsx
  const showProof = false; // TEMP: R2-off visual check, revert before committing
```

Reload the page and confirm the header now reads 成員 方案 期別 金額 狀態 申報渠道 with no 憑證 column (7 columns). Then revert the stub and prove the file is back to the committed intent:

```bash
grep -n 'const showProof' packages/admin/src/views/Payments.tsx
bash /tmp/assert-task2.sh; echo "exit=$?"
```
Expected: the single line `const showProof = ws.data?.r2_configured !== false;` and `exit=0`. Stop the dev server (Ctrl-C). Row-level `colSpan` rendering with real data is verified by the owner after deploy (Task 3) — it cannot be exercised locally without a worker API proxy.

- [ ] **Step 10: Commit**

```bash
git add packages/admin/src/views/Payments.tsx
git commit -m "feat(admin): 未設定 R2 時隱藏繳費審核的憑證欄，colSpan 改為依實際欄數推導"
```

---

### Task 3: Full CI-parity gates, PR, and deploy-state entry

**Files:**
- Modify: `docs/deploy-state.md` (append one section at the very end)
- Test: none — this task's verification is the CI-parity command run in Step 1.

**Interfaces:**
- Consumes: the finished `packages/admin/src/views/Payments.tsx` from Tasks 1-2 and the worker test baseline recorded in Task 1 Step 2.
- Produces: branch `feat/29-payments-table-columns` pushed, a PR whose body contains `Closes #29`, and a `docs/deploy-state.md` section named `## 繳費審核表格欄位調整 (PR #NN, 2026-07-28)`.

- [ ] **Step 1: Run the full CI-parity gate set**

```bash
cd /Users/poterpan/Documents/Coding/Project/chippot
pnpm -r typecheck
pnpm -r test
VITE_API_BASE=https://example.invalid pnpm -r build
```
Expected: typecheck clean across all three packages; worker suite the same count as the Task 1 baseline (**243 passed**, 0 failed — this branch touches no worker code); all three package builds succeed. If the test count differs from the baseline, stop and investigate before opening the PR.

- [ ] **Step 2: Confirm the branch touches exactly one source file**

```bash
git diff --stat main...HEAD
```
Expected: only `packages/admin/src/views/Payments.tsx`. If `packages/worker/wrangler.toml` or anything under `packages/worker` appears, revert it — the plan requires no worker change and `wrangler.toml` must never be committed from this machine.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/29-payments-table-columns
gh pr create --base main --head feat/29-payments-table-columns \
  --title "feat(admin): 繳費審核表格顯示申報渠道、移除來源、R2 未設定時隱藏憑證欄 (#29)" \
  --body "$(cat <<'EOF'
Closes #29

## 變更
- 繳費審核表格新增 **申報渠道** 欄（`declared_channel_tag_name`，無值顯示「—」）。
- 移除表格的 **來源** 欄；來源資訊仍在詳情彈窗（`<dt>來源</dt>`）可查。
- 未設定 R2（`workspace.r2_configured === false`）時整欄隱藏 **憑證**。
- 欄位順序：成員 | 方案 | 期別 | 金額 | 狀態 | 申報渠道 | 憑證（僅 R2 開啟）| 操作。
- 載入中／無資料列的 `colSpan` 改由 `BASE_COLS + (showProof ? 1 : 0)` 推導，不再是硬編碼 8，避免與實際欄數脫節。

依 owner 決定，**不做**「使用者自訂顯示欄位」（issue 內提到的另一個方向）。

## 影響範圍
純前端，只動 `packages/admin/src/views/Payments.tsx`。後端無變更 —— `GET /admin/payments` 早已回傳
`declared_channel_tag_name`，`GET /admin/workspace` 早已回傳 `r2_configured`。

## 驗證
- `pnpm -r typecheck` 全綠；`pnpm -r test` worker 243 passed（未動 worker 程式碼）；`pnpm -r build` 三個 package 皆過。
- `packages/admin` 無測試框架（僅 dev/build/preview/typecheck），本 PR 未新增測試框架；改以 tsc + vite build
  加上 vite dev 實際檢視表頭（R2 開／關兩種情況）驗證。
EOF
)"
```
Note the PR number it prints — Step 4 needs it.

- [ ] **Step 4: Append the deploy-state entry**

`docs/deploy-state.md` is a zh-TW log with one `## <描述> (PR #NN, YYYY-MM-DD)` section per shipped change, appended at the bottom (newest last — see `## 修正：清空 Discord ID 可解除綁定 (PR #24, 2026-06-23)` at the current end of file). Append this section at the very end, replacing `NN` with the number from Step 3:

```markdown

## 繳費審核表格欄位調整 (PR #NN, 2026-07-28)
- issue #29: 對帳時最常要看的「申報渠道」原本得點進詳情才看得到。表格改為：加 **申報渠道** 欄、
  移除 **來源** 欄（來源仍在詳情彈窗可查）、未設定 R2 時整欄隱藏 **憑證**。
  欄序 = 成員｜方案｜期別｜金額｜狀態｜申報渠道｜憑證(R2 開啟時)｜操作。
- 載入中／無資料列的 `colSpan` 改由 `BASE_COLS(7) + (showProof ? 1 : 0)` 推導，R2 開 8、關 7，
  不再硬編碼；`showProof = ws.data?.r2_configured !== false`（與 App.tsx R2Notice 同一判定，載入中先顯示）。
- owner 明確否決「使用者自訂顯示欄位」，故未做偏好設定 UI。
- 純前端，只動 `packages/admin/src/views/Payments.tsx`；後端／schema 無變更（`declared_channel_tag_name`
  與 `r2_configured` 早已是 API 回傳欄位）。
- Worker tests **243 passed**（未動 worker）；admin tsc + vite build OK。`packages/admin` 無測試框架，
  本次未引入，改以 vite dev 檢視表頭（R2 開／關）+ 結構性 grep 斷言驗收。
```

If the deploy happens in the same session, append one more line recording the Admin Pages deployment URL, matching the existing entries' style (`- Deploy: admin Pages only (<url>)；worker 不變。`). Do not invent a URL — only write the one `wrangler pages deploy` actually printed.

- [ ] **Step 5: Commit and push the doc entry**

```bash
git add docs/deploy-state.md
git commit -m "docs(deploy-state): 記錄 #29 繳費審核表格欄位調整"
git push
```

- [ ] **Step 6: Confirm CI is green on the PR**

```bash
gh pr checks --watch
```
Expected: the `check` job passes (typecheck, worker tests, all builds, and the web-build-must-fail guard).

---

## Self-review (run by the plan author, 2026-07-28)

**1. Spec coverage**

| Spec item | Implemented by |
|---|---|
| 1. ADD 申報渠道 column | Task 1 Steps 5-6 (header + `<td>{p.declared_channel_tag_name \|\| —}</td>`); asserted by `/tmp/assert-task1.sh` checks 3-4 |
| 2. REMOVE 來源 from table, keep it in the modal | Task 1 Steps 5-6 (delete `<th>來源</th>` and the `{p.source}` cell) + Step 7 verification; regression-guarded by `/tmp/assert-task1.sh` check 5. Verified 2026-07-28 that the modal already renders `<dt>來源</dt><dd>{payment.source}</dd>`, so no modal edit is needed |
| 3. HIDE 憑證 when `r2_configured === false` | Task 2 Steps 4-6 (`showProof`, gated `<th>` and `<td>`); asserted by `/tmp/assert-task2.sh` checks 3-5 and visually checked in Step 9 |
| 4. Column order + alignment conventions | Task 2 Step 6 shows the complete final block; 金額 keeps `className="right"`, actions keeps `className="right"`, 期別 keeps `className="mono"` |
| 5. `colSpan` matches rendered count in both R2 states | Task 2 Steps 4-5 (`colCount = BASE_COLS + (showProof ? 1 : 0)`, both placeholder rows); asserted by `/tmp/assert-task2.sh` checks 1-2 |
| 6. No user-configurable columns | Global Constraints, and repeated in the PR body; no task adds preference UI |

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step carries the literal JSX or shell to run. The only intentional fill-in is the PR number (`#NN`) in Task 3 Step 4, which Step 3 obtains from `gh pr create`, plus the deploy URL, which Step 4 explicitly forbids inventing. The `TEMP:` comment in Task 2 Step 9 is a deliberate throwaway stub with a revert-and-prove step.

**3. Type consistency:** `showProof: boolean` and `colCount: number` are defined in Task 2 Step 4 and used under those exact names in Steps 5-6 and in both assertion scripts. `BASE_COLS` is module-level (Task 2 Step 3). `Payment.declared_channel_tag_name` is `string | null` (`packages/admin/src/api.ts:28`), so the `||` fallback is type-correct in JSX. `api.workspace()` returns `{ workspace: any; r2_configured: boolean }` (`api.ts:48`) and `useAsync` returns `{ data: T | null; … }` (`ui.tsx:20`), so `ws.data?.r2_configured` is `boolean | undefined` and `!== false` needs no cast. No new function or type is introduced.

**4. The final code in this plan was compile-verified before the plan shipped (2026-07-28).** The plan author applied Task 1 + Task 2 to a scratch copy, swapped it into the working tree, and ran `pnpm --filter @chippot/admin typecheck` (exit 0, no output) and `pnpm --filter @chippot/admin build` (`✓ 33 modules transformed`, `✓ built in 401ms`), then restored the file (`git diff --exit-code` clean). Both assertion scripts were also run against the before/after files: they fail with the exact messages quoted in Task 1 Step 4 and Task 2 Step 2 on current code, and pass with all `ok:` lines on the final code. The Task 1 diff is 2 hunks, the Task 2 diff is 4 hunks. So the code blocks in this plan are known-good copy-paste targets, and every `old_string` anchor quoted above matched the real file exactly once.

**5. Verified against current code (2026-07-28):** `Payments.tsx:79` header, `:81-82` `colSpan={8}` ×2, `:95` `{p.source}` cell, `:230` `<dt>來源</dt>`, `:22` existing `api.workspace()` call with no prior `r2_configured` usage in the file, `admin.ts:504-511` `dct.name AS declared_channel_tag_name`, `admin.ts:54` `r2_configured: !!env.BUCKET`, `App.tsx:23` `r2_configured === false` convention, `README.md` does not document these columns, `docs/deploy-state.md` newest-last section convention.
