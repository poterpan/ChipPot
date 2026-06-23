import { useEffect, useState } from "react";
import { api, currentPeriod, periodForBillingDay, type Payment, type ChannelTag, type ReconcileDiff } from "../api";
import { useAsync, Card, Modal, Field, Empty, Money, Stat, StatusBadge, IconCheck, IconWarning, IconX } from "../ui";

const STATUS_OPTS = [
  { v: "", label: "全部" },
  { v: "paid", label: "已繳待驗" },
  { v: "pending", label: "待繳" },
  { v: "verified", label: "已驗證" },
  { v: "rejected", label: "已退回" },
];

// Read the deep-link payment id from "#payments?id=42"; null if absent or not a positive integer.
function paymentIdFromHash(): number | null {
  const q = window.location.hash.split("?")[1];
  const raw = q ? new URLSearchParams(q).get("id") : null;
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function Payments() {
  const ws = useAsync(() => api.workspace(), []);
  const billingDay = (ws.data as any)?.workspace?.billing_day ?? 1;
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

  const reload = () => { list.reload(); };

  // Deep link from a payment notification (#payments?id=42): fetch that payment directly (it may be
  // outside the current period/status filter) and open its review modal, then clean the query so a
  // refresh doesn't reopen it. Re-runs on hashchange so navigating between links works.
  const [deepId, setDeepId] = useState<number | null>(() => paymentIdFromHash());
  useEffect(() => {
    const onHash = () => setDeepId(paymentIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (deepId == null) return;
    let cancelled = false;
    api.payments({}).then((r) => {
      if (cancelled) return;
      const p = r.payments.find((x) => x.id === deepId);
      if (p) setSelected(p);
      setDeepId(null);
      if (window.location.hash.includes("?")) history.replaceState(null, "", "#payments");
    }).catch(() => { if (!cancelled) setDeepId(null); });
    return () => { cancelled = true; };
  }, [deepId]);

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
        <button className="btn" disabled={!effPeriod} title={effPeriod ? "對齊本期帳單到目前名單／現價" : "請先選擇單一期別"} onClick={() => setSync(true)}>重新同步本期</button>
        <button className="btn" onClick={() => setShowLink(true)}>產生上傳連結</button>
        <button className="btn btn--primary" onClick={() => setShowManual(true)}>手動補登</button>
      </div>

      {list.error && <div className="error-banner">{list.error}</div>}
      <Card title="繳費紀錄">
        <div className="tbl">
          <table>
            <thead><tr><th>成員</th><th>方案</th><th>期別</th><th className="right">金額</th><th>狀態</th><th>憑證</th><th>來源</th><th></th></tr></thead>
            <tbody>
              {list.loading && <tr><td colSpan={8}><Empty>載入中…</Empty></td></tr>}
              {list.data?.payments.length === 0 && <tr><td colSpan={8}><Empty>沒有符合的紀錄</Empty></td></tr>}
              {list.data?.payments.map((p) => (
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
    </>
  );
}

function DiffList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <details style={{ margin: "6px 0" }}>
      <summary style={{ cursor: "pointer" }}>{title}（{rows.length}）</summary>
      <ul style={{ margin: "6px 0 0 18px", color: "var(--muted)", fontSize: 13 }}>
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </details>
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
  const changes = diff ? diff.add.length + diff.remove.length + diff.reprice.length : 0;

  async function apply() {
    if (busy) return; // belt: button is also disabled while in-flight
    setBusy(true); setErr(null);
    try {
      const r = await api.syncPeriodBills(period, { dry_run: false, notify_added: notify && boundAdds.length > 0 }) as any;
      setDone(`已套用：新增 ${r.applied.added}、移除 ${r.applied.removed}、改價 ${r.applied.repriced}、保留 ${r.applied.frozen}` + (r.notified ? `；已通知 ${r.notified} 位新成員` : ""));
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
          {diff.remove.length > 0 && <DiffList title="移除（已退訂）" rows={diff.remove.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {diff.reprice.length > 0 && <DiffList title="改價" rows={diff.reprice.map((a) => `${a.user_name}·${a.plan_name} ${a.from}→${a.to}`)} />}
          {boundAdds.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              在頻道 @ 通知這 {boundAdds.length} 位新成員並附繳費按鈕
            </label>
          )}
          {changes === 0
            ? <p style={{ color: "var(--muted)" }}>本期已是最新，無需變更。</p>
            : <button className="btn btn--primary" disabled={busy} onClick={apply}>確認套用</button>}
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
    <button className="btn iconlbl" disabled={busy} onClick={run} title="標記已驗證（帶入申報渠道）">
      {busy ? "…" : err ? <><IconX />重試</> : <><IconCheck />驗證</>}
    </button>
  );
}

function PaymentDetail({ payment, tags, onClose, onDone }: { payment: Payment; tags: ChannelTag[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tagId, setTagId] = useState<number | "">(payment.verified_channel_tag_id ?? payment.declared_channel_tag_id ?? "");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(String(payment.amount));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const canVerify = ["pending", "paid", "rejected"].includes(payment.status);
  const canReject = ["pending", "paid"].includes(payment.status);

  return (
    <Modal title={`${payment.user_name} · ${payment.plan_name} · ${payment.period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <dl className="kv">
        <dt>狀態</dt><dd><StatusBadge status={payment.status} /></dd>
        <dt>金額</dt><dd><Money v={payment.amount} /></dd>
        <dt>應繳日</dt><dd className="mono">{payment.due_date}</dd>
        <dt>來源</dt><dd>{payment.source}</dd>
        {payment.payment_note && (<><dt>使用者備註</dt><dd>{payment.payment_note}</dd></>)}
        {payment.declared_channel_tag_name && (<><dt>申報渠道</dt><dd>{payment.declared_channel_tag_name}</dd></>)}
        {payment.channel_tag_name && (<><dt>認定渠道</dt><dd>{payment.channel_tag_name}</dd></>)}
        {payment.rejected_reason && (<><dt>退回原因</dt><dd>{payment.rejected_reason}</dd></>)}
      </dl>

      {payment.has_proof && payment.screenshot_key && (
        <img className="proof-img" src={api.imageUrl(payment.screenshot_key)} alt="繳費截圖" />
      )}
      {payment.has_proof === 1 && !payment.screenshot_key && payment.proof_deleted_at && (
        <p style={{ color: "var(--muted)" }}>截圖已依保存期於 {payment.proof_deleted_at} 刪除（對帳資料保留）。</p>
      )}
      {!payment.has_proof && <p style={{ color: "var(--amber)" }}><IconWarning /> 無憑證，純聲明 — 請依備註與帳戶自行核對。</p>}

      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "18px 0" }} />

      {canVerify && (
        <Field label="認定渠道（對帳分組依據）">
          <select value={tagId} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : "")} disabled={busy}>
            <option value="">（不指定）</option>
            {tags.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}

      <div className="btn-row">
        {canVerify && <button className="btn btn--primary" disabled={busy} onClick={() => run(() => api.verify(payment.id, tagId === "" ? null : Number(tagId)))}>標記已驗證</button>}
        {payment.status === "verified" && <button className="btn" disabled={busy} onClick={() => run(() => api.unverify(payment.id))}>撤回驗證</button>}
        {payment.screenshot_key && <button className="btn btn--danger" disabled={busy} onClick={() => run(() => api.deleteProof(payment.id))}>刪除截圖</button>}
      </div>

      {canReject && (
        <div style={{ marginTop: 16 }}>
          <Field label="退回原因（選填）"><input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></Field>
          <button className="btn btn--danger" disabled={busy} onClick={() => run(() => api.reject(payment.id, reason))}>退回</button>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Field label="單筆覆寫金額"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></Field>
        <button className="btn" disabled={busy} onClick={() => run(() => api.overrideAmount(payment.id, Number(amount)))}>更新金額</button>
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "18px 0" }} />
      <button
        className="btn btn--danger"
        disabled={busy}
        onClick={() => {
          const hasHistory = payment.status !== "pending"; // paid/verified/rejected all carry real activity
          const msg = hasHistory
            ? "這筆已有繳費／審核紀錄，刪除後將從對帳與紀錄中消失且無法復原（仍保留稽核紀錄）。確定刪除？"
            : "確定刪除這筆待繳紀錄？（保留稽核紀錄）";
          if (window.confirm(msg)) run(() => api.deletePayment(payment.id));
        }}
      >刪除此筆</button>
    </Modal>
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
      <Field label="訂閱">
        <select value={subId} onChange={(e) => setSubId(e.target.value)} disabled={busy}>
          <option value="">選擇…</option>
          {subs.data?.subscriptions.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>{s.user_name} · {s.plan_name}</option>)}
        </select>
      </Field>
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
      <Field label="成員">
        <select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={busy}>
          <option value="">選擇…</option>
          {users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </Field>
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
