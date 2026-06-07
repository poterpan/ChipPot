import { useState } from "react";
import { api, currentPeriod, periodForBillingDay, type Payment, type ChannelTag } from "../api";
import { useAsync, Card, Modal, Field, Empty, Money, StatusBadge, IconCheck, IconWarning, IconX } from "../ui";

const STATUS_OPTS = [
  { v: "", label: "全部" },
  { v: "paid", label: "已繳待驗" },
  { v: "pending", label: "待繳" },
  { v: "verified", label: "已驗證" },
  { v: "rejected", label: "已退回" },
];

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

  const reload = () => { list.reload(); };

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
    </>
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
