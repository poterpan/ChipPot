import { useEffect, useState } from "react";
import { api, currentPeriod, periodForBillingDay, type Payment, type ChannelTag, type ReconcileDiff, type RetractPreview, type RetractApplied } from "../api";
import { useAsync, Card, Modal, Field, Empty, Money, Stat, StatusBadge, IconCheck, IconWarning, IconX, ErrorNote, FilterSelect } from "../ui";
import { DiffList } from "../components/DiffList";
import { PaymentDetail } from "./PaymentDetail";
import { MemberReview } from "./MemberReview";

const STATUS_OPTS = [
  { v: "", label: "全部" },
  { v: "paid", label: "已繳待驗" },
  { v: "pending", label: "待繳" },
  { v: "verified", label: "已驗證" },
  { v: "rejected", label: "已退回" },
];

// Fixed table columns: 成員·方案·期別·金額·狀態·申報渠道 + the actions column. 憑證 is conditional
// (R2-only) and adds one on top — see colCount in Payments(), which every colSpan must use.
const BASE_COLS = 7;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type DeepLink =
  | { kind: "member"; userId: number; period: string }
  | { kind: "payment"; id: number };

/**
 * Where a payment-submission notification lands. Current shape: "#payments?user=42&period=2026-07"
 * — a member's whole period, because one submit settles several rows. Pushes already in the owner's
 * history carry the older "#payments?id=1042", which still opens that single payment's modal.
 */
function deepLinkFromHash(): DeepLink | null {
  const q = window.location.hash.split("?")[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  const userId = Number(params.get("user"));
  const period = params.get("period") ?? "";
  if (Number.isInteger(userId) && userId > 0 && PERIOD_RE.test(period)) return { kind: "member", userId, period };
  const id = Number(params.get("id"));
  if (Number.isInteger(id) && id > 0) return { kind: "payment", id };
  return null;
}

export function Payments() {
  const ws = useAsync(() => api.workspace(), []);
  const billingDay = (ws.data as any)?.workspace?.billing_day ?? 1;
  // Without R2 no payment can ever have a screenshot, so the 憑證 column is dead weight — hide it.
  // Matches App.tsx's `r2_configured === false` check: while the workspace is still loading the flag
  // is undefined and we show the column (the configured case is the common one).
  const showProof = ws.data?.r2_configured !== false;
  const colCount = BASE_COLS + (showProof ? 1 : 0);
  // null = "follow the billing-day-aware default"; "" = the admin cleared it (全部); a string = typed.
  const [period, setPeriod] = useState<string | null>(null);
  const effPeriod = period ?? periodForBillingDay(billingDay);
  const [status, setStatus] = useState("");
  const tags = useAsync(() => api.channelTags(), []);
  const list = useAsync(() => api.payments({ period: effPeriod || undefined, status: status || undefined }), [effPeriod, status]);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [sync, setSync] = useState(false);
  const [retract, setRetract] = useState(false);

  const reload = () => { list.reload(); };

  const [deep, setDeep] = useState<DeepLink | null>(deepLinkFromHash);
  const [deepMiss, setDeepMiss] = useState(false);
  useEffect(() => {
    // Any new link supersedes the previous one, including its "that payment is gone" notice.
    const onHash = () => { setDeep(deepLinkFromHash()); setDeepMiss(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Legacy single-payment link: fetch just that row (a filtered request — it may sit outside the
  // current period/status filters), open its review modal, then clean the query so a refresh
  // doesn't reopen it. The member × period form is handled by the branch below instead.
  useEffect(() => {
    if (deep?.kind !== "payment") return;
    let cancelled = false;
    api.payments({ id: deep.id }).then((r) => {
      if (cancelled) return;
      const p = r.payments[0];
      // A deleted payment (or an id from another workspace) comes back as an empty list, not a 404 —
      // say so instead of dropping the admin on an unexplained list.
      if (p) setSelected(p); else setDeepMiss(true);
      setDeep(null);
      if (window.location.hash.includes("?")) history.replaceState(null, "", "#payments");
    }).catch(() => { if (!cancelled) setDeep(null); });
    return () => { cancelled = true; };
  }, [deep]);

  // Aggregate review takes over the whole view — it IS the notification landing page. Leaving it
  // via 返回 rewrites the hash, which fires hashchange and drops us back to the list.
  // The key remounts on every member × period: App.tsx keys the content wrapper on the view id
  // ("payments" for both links), so tapping notification B while looking at A would otherwise reuse
  // this instance and keep A's success line, open modal and — until the refetch lands — A's rows.
  if (deep?.kind === "member") {
    return (
      <MemberReview
        key={`${deep.userId}:${deep.period}`}
        userId={deep.userId}
        period={deep.period}
        tags={tags.data?.channel_tags ?? []}
        onBack={() => { list.reload(); window.location.hash = "payments"; }}
      />
    );
  }

  return (
    <>
      <div className="toolbar">
        <label>期別 <input type="month" value={effPeriod} onChange={(e) => setPeriod(e.target.value)} style={{ width: 160 }} /></label>
        <button className="btn" onClick={() => setPeriod("")} disabled={!effPeriod} title="顯示全部期別">全部期別</button>
        <div className="pills">
          {STATUS_OPTS.map((o) => (
            <button key={o.v} className={`pill ${status === o.v ? "pill--on" : ""}`} onClick={() => setStatus(o.v)}>{o.label}</button>
          ))}
        </div>
        <div className="grow" style={{ flex: 1 }} />
        {/* One group so the four one-off period tools can become a single scrollable row on a
            phone instead of four stacked bands. Below 1000px .toolbar__acts is a nowrap scroller
            with an edge fade; above it, it is a plain flex row and looks unchanged. */}
        <div className="toolbar__acts">
          <button className="btn" disabled={!effPeriod} title={effPeriod ? "對齊本期帳單到目前名單／現價" : "請先選擇單一期別"} onClick={() => setSync(true)}>重新同步本期</button>
          <button className="btn btn--danger" disabled={!effPeriod} title={effPeriod ? "刪除本期未繳／已退回帳單，期別回到未開繳" : "請先選擇單一期別"} onClick={() => setRetract(true)}>收回本期開繳</button>
          <button className="btn" onClick={() => setShowLink(true)}>產生上傳連結</button>
          <button className="btn btn--primary" onClick={() => setShowManual(true)}>手動補登</button>
        </div>
      </div>

      {deepMiss && <div className="warnnote">找不到通知連結指向的那筆繳費紀錄，可能已被刪除。以下是目前的繳費列表。</div>}
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      <Card title="繳費紀錄">
        <div className="tbl tbl--pin-first tbl--pin-last">
          {/* tbl-cards: below 1000px these rows stack into cards, each cell labelled by its data-label */}
          <table className="tbl-cards">
            <caption className="sr-only">繳費紀錄</caption>
            <thead><tr><th scope="col">成員</th><th scope="col">方案</th><th scope="col">期別</th><th scope="col" className="right">金額</th><th scope="col">狀態</th><th scope="col">申報渠道</th>{showProof && <th scope="col">憑證</th>}<th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {list.loading && <tr><td colSpan={colCount}><Empty>載入中…</Empty></td></tr>}
              {list.data?.payments.length === 0 && <tr><td colSpan={colCount}><Empty>沒有符合的紀錄</Empty></td></tr>}
              {list.data?.payments.map((p) => (
                <tr
                  key={p.id}
                  className="click"
                  tabIndex={0}
                  aria-label={`${p.user_name} · ${p.plan_name} · ${p.period} 繳費明細`}
                  onClick={() => setSelected(p)}
                  // PaymentDetail was reachable only by clicking the row background; the keyboard
                  // detour (成員 → MemberReview → 完整資訊) works but nobody would find it.
                  // No role="button": that would strip the row/cell semantics screen readers need.
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return; // a button inside the row handles its own keys
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p); }
                  }}
                >
                  <td data-label="成員">
                    <button className="linkbtn" title="檢視這位成員本期的合併審核"
                      onClick={(e) => { e.stopPropagation(); window.location.hash = `payments?user=${p.user_id}&period=${p.period}`; }}>
                      {p.user_name}
                    </button>
                  </td>
                  <td data-label="方案">{p.plan_name}</td>
                  <td data-label="期別" className="mono">{p.period}</td>
                  <td data-label="金額" className="right"><Money v={p.amount} /></td>
                  <td data-label="狀態"><StatusBadge status={p.status} /></td>
                  <td data-label="申報渠道">{p.declared_channel_tag_name || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  {showProof && <td data-label="憑證">{
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

      {selected && (
        <PaymentDetail
          payment={selected}
          tags={tags.data?.channel_tags ?? []}
          onClose={() => setSelected(null)}
          onDone={() => { setSelected(null); reload(); }}
        />
      )}
      {showManual && <ManualModal tags={tags.data?.channel_tags ?? []} onClose={() => setShowManual(false)} onDone={() => { setShowManual(false); reload(); }} />}
      {showLink && <LinkModal onClose={() => setShowLink(false)} />}
      {sync && effPeriod && <SyncModal key={effPeriod} period={effPeriod} onClose={() => setSync(false)} onDone={() => reload()} />}
      {retract && effPeriod && <RetractModal key={effPeriod} period={effPeriod} onClose={() => setRetract(false)} onDone={() => reload()} />}
    </>
  );
}

function SyncModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [diff, setDiff] = useState<ReconcileDiff | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.syncPeriodBills(period, { dry_run: true })
      .then((d) => { if (!off) { setDiff(d as ReconcileDiff); setBusy(false); } })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  const boundAdds = diff?.add?.filter((a) => a.discord_id) ?? [];
  // 未綁定的人 @ 不到——說出來，否則管理員會以為每個新成員都收到通知了 (C9)。
  const unboundAdds = diff?.add?.filter((a) => !a.discord_id) ?? [];
  const changes = diff ? diff.add.length + diff.remove.length + diff.reprice.length : 0;

  async function apply() {
    if (busy) return; // belt: button is also disabled while in-flight
    setBusy(true); setErr(null);
    try {
      const r = await api.syncPeriodBills(period, { dry_run: false, notify_added: notify && boundAdds.length > 0 }) as any;
      setDone(
        `已套用：新增 ${r.applied.added}、移除 ${r.applied.removed}、改價 ${r.applied.repriced}、保留 ${r.applied.frozen}`
        + (r.notified ? `；已通知 ${r.notified} 位` : "")
        + (r.unbound ? `；${r.unbound} 位未綁定、通知不到` : "")
      );
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`重新同步本期帳單 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !diff && <Empty>計算差異中…</Empty>}
      {done && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{done}</div>}
      {diff && !diff.opened && !done && <p style={{ color: "var(--muted)" }}>此期尚未發起繳費，無需同步。</p>}
      {diff && diff.opened && !done && (
        <>
          <div className="stats">
            <Stat label="➕ 新增" value={diff.add.length} />
            <Stat label="➖ 移除" value={diff.remove.length} />
            <Stat label="🔄 改價" value={diff.reprice.length} />
            <Stat label="🔒 保留(已繳)" value={diff.frozen_count} />
          </div>
          {diff.add.length > 0 && <DiffList title="新增" rows={diff.add.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {diff.remove.length > 0 && <DiffList title="移除（訂閱已暫停／已取消）" rows={diff.remove.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {diff.reprice.length > 0 && <DiffList title="改價" rows={diff.reprice.map((a) => `${a.user_name}·${a.plan_name} ${a.from}→${a.to}`)} />}
          {boundAdds.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              在頻道 @ 通知這 {boundAdds.length} 位新成員並附繳費按鈕
            </label>
          )}
          {unboundAdds.length > 0 && (
            <div className="warnnote">
              另 {unboundAdds.length} 位尚未綁定 Discord，@ 不到：{unboundAdds.map((a) => a.user_name).join("、")}。
              請到「成員」頁用「未綁定」篩選確認，或請他們點頻道裡的「綁定 Discord」按鈕。
            </div>
          )}
          {changes === 0
            ? <p style={{ color: "var(--muted)" }}>本期已是最新，無需變更。</p>
            : <button className="btn btn--primary" disabled={busy} onClick={apply}>確認套用</button>}
        </>
      )}
    </Modal>
  );
}

/**
 * 收回本期開繳 — the way back from a mis-opened month. Two steps like SyncModal: a preview of what
 * the retract would delete, then a red confirm. The frozen (paid/verified) count is spelled out
 * because "收回" easily reads as "wipe the month", which is exactly what it does NOT do.
 */
function RetractModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<RetractPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.retractPeriodBilling(period, { dry_run: true })
      .then((r) => { if (!off) { setPreview(r as RetractPreview); setBusy(false); } })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return; // belt: button is also disabled while in-flight
    setBusy(true); setErr(null);
    try {
      const r = await api.retractPeriodBilling(period, { dry_run: false }) as RetractApplied;
      setDone(`已收回 ${period}：刪除 ${r.applied.removed} 筆帳單、保留 ${r.applied.frozen} 筆已繳。此期已回到未開繳狀態。`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`收回本期開繳 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !preview && <Empty>計算中…</Empty>}
      {done && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{done}</div>}
      {preview && !preview.opened && !done && <p style={{ color: "var(--muted)" }}>此期尚未發起繳費，無需收回。</p>}
      {preview && preview.opened && !done && (
        <>
          <div className="stats">
            <Stat label="🗑️ 將刪除" value={preview.removed.length} />
            <Stat label="🔒 保留(已繳)" value={preview.frozen_count} />
          </div>
          {preview.removed.length > 0
            ? <DiffList title="將刪除的帳單（未繳／已退回）" rows={preview.removed.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />
            /* Still worth doing: the marker alone is what keeps the period "opened". */
            : <p style={{ color: "var(--muted)" }}>本期沒有可刪除的未繳／已退回帳單，收回只會把期別改回「未開繳」。</p>}
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            {/* One source line per sentence would render an ASCII space between them (JSX joins
                adjacent text lines), which reads as a gap in a run of CJK. */}
            收回後本期回到「未開繳」：刪掉的帳單不會被「重新同步本期」補回來，日後可以再次發起繳費（屆時會重新發送開繳通知）。此期先前用「產生上傳連結」發出去的一次性連結會<b>立即失效</b>，對方點開只會看到連結無效。
            {preview.frozen_count > 0 && `已繳／已驗證的 ${preview.frozen_count} 筆一律原樣保留，重開本期也不會重複開帳單。`}
            已經發出的 Discord 開繳通知不會撤回，必要時請自行到頻道說明。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認收回</button>
        </>
      )}
    </Modal>
  );
}

function QuickVerify({ id, onDone }: { id: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  async function run() {
    setBusy(true); setErr(false);
    try { await api.verify(id, null); onDone(); }
    catch { setErr(true); setBusy(false); }
  }
  return (
    <button className="btn iconlbl" disabled={busy} onClick={run} title="標記為「已驗證」（帶入申報渠道）">
      {busy ? "…" : err ? <><IconX />重試</> : <><IconCheck />驗證</>}
    </button>
  );
}

function ManualModal({ tags, onClose, onDone }: { tags: ChannelTag[]; onClose: () => void; onDone: () => void }) {
  const subs = useAsync(() => api.subscriptions(), []);
  const [subId, setSubId] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [amount, setAmount] = useState("");
  const [statusV, setStatusV] = useState("verified");
  const [tagId, setTagId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!subId) { setErr("請選擇訂閱"); return; }
    setBusy(true); setErr(null);
    try {
      await api.manualPayment({ subscription_id: Number(subId), period, amount: amount ? Number(amount) : undefined, status: statusV, verified_channel_tag_id: tagId ? Number(tagId) : undefined, payment_note: note || undefined });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title="手動補登繳費" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <FilterSelect label="訂閱" value={subId} disabled={busy} onChange={setSubId}
        options={(subs.data?.subscriptions ?? []).filter((s) => s.status === "active")
          .map((s) => ({ value: String(s.id), label: `${s.user_name} · ${s.plan_name}` }))} />
      <Field label="期別"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} /></Field>
      <Field label="金額（留空＝方案金額）"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></Field>
      <Field label="狀態">
        <select value={statusV} onChange={(e) => setStatusV(e.target.value)} disabled={busy}>
          <option value="verified">已驗證</option>
          <option value="paid">已繳待驗</option>
          <option value="pending">待繳</option>
        </select>
      </Field>
      <Field label="認定渠道（選填）">
        <select value={tagId} onChange={(e) => setTagId(e.target.value)} disabled={busy}>
          <option value="">（不指定）</option>
          {tags.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <Field label="備註（選填）"><input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></Field>
      <button className="btn btn--primary" disabled={busy} onClick={submit}>補登</button>
    </Modal>
  );
}

function LinkModal({ onClose }: { onClose: () => void }) {
  const users = useAsync(() => api.users(), []);
  const [userId, setUserId] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function gen() {
    if (!userId) { setErr("請選擇成員"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.uploadLink({ user_id: Number(userId), period });
      setLink(r.url);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal title="產生一次性上傳連結" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <FilterSelect label="成員" value={userId} disabled={busy} onChange={setUserId}
        options={(users.data?.users ?? []).map((u) => ({ value: String(u.id), label: u.display_name }))} />
      <Field label="期別"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} /></Field>
      <button className="btn btn--primary" disabled={busy} onClick={gen}>產生連結</button>
      {link && (
        <div style={{ marginTop: 16 }}>
          <div className="field__label">連結（30 分鐘內有效，手動貼給對方）</div>
          <div className="link-box">{link}</div>
        </div>
      )}
    </Modal>
  );
}
