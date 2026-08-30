import { useState } from "react";
import { api, type ChannelTag, type Payment } from "../api";
import { Modal, Field, Money, StatusBadge, IconWarning, ConfirmDanger } from "../ui";

export function PaymentDetail({ payment, tags, onClose, onDone }: { payment: Payment; tags: ChannelTag[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tagId, setTagId] = useState<number | "">(payment.verified_channel_tag_id ?? payment.declared_channel_tag_id ?? "");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(String(payment.amount));
  const [confirmDel, setConfirmDel] = useState(false);

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
        {canVerify && <button className="btn btn--primary" disabled={busy} onClick={() => run(() => api.verify(payment.id, tagId === "" ? null : Number(tagId)))}>驗證</button>}
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
      <button className="btn btn--danger" disabled={busy} onClick={() => setConfirmDel(true)}>刪除此筆</button>
      {confirmDel && (
        <ConfirmDanger
          title="刪除此筆繳費紀錄"
          // paid/verified/rejected all carry real activity; only pending is re-creatable by a resync.
          message={payment.status !== "pending"
            ? "這筆已有繳費／審核紀錄，刪除後將從對帳與紀錄中消失且無法復原（稽核紀錄仍會保留）。"
            : "刪除這筆待繳紀錄後，「重新同步本期」會在該訂閱仍為啟用時把它補回來（稽核紀錄仍會保留）。"}
          confirmLabel="確認刪除"
          busyLabel="刪除中…"
          onClose={() => setConfirmDel(false)}
          onConfirm={() => api.deletePayment(payment.id).then(() => { setConfirmDel(false); onDone(); })}
        />
      )}
    </Modal>
  );
}
