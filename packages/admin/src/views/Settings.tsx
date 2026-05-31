import { useEffect, useState } from "react";
import { api, currentPeriod } from "../api";
import { useAsync, Card, Field, Empty, Modal } from "../ui";

export function Settings() {
  const { data, loading, error } = useAsync(() => api.workspace(), []);
  const [billingDay, setBillingDay] = useState("5");
  const [overdue, setOverdue] = useState("3");
  const [retention, setRetention] = useState("24");
  const [delMsg, setDelMsg] = useState(false);
  const [guild, setGuild] = useState("");
  const [channel, setChannel] = useState("");
  const [adminIds, setAdminIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const w = (data as any).workspace;
    setBillingDay(String(w.billing_day));
    setOverdue(String(w.settings.overdue_days));
    setRetention(String(w.settings.proof_retention_months));
    setDelMsg(!!w.settings.delete_discord_original_message);
    setGuild(w.settings.discord_guild_id ?? "");
    setChannel(w.settings.discord_billing_channel_id ?? "");
    setAdminIds((w.settings.admin_discord_ids ?? []).join(", "));
  }, [data]);

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api.updateWorkspace({
        billing_day: Number(billingDay),
        settings: {
          overdue_days: Number(overdue),
          proof_retention_months: Number(retention),
          delete_discord_original_message: delMsg,
          discord_guild_id: guild,
          discord_billing_channel_id: channel,
          admin_discord_ids: adminIds.split(",").map((s) => s.trim()).filter(Boolean),
        },
      });
      setSaved(true);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <Card title="設定">
      <div style={{ padding: "18px 20px", maxWidth: 460 }}>
        {err && <div className="error-banner">{err}</div>}
        {saved && <div style={{ color: "var(--teal)", marginBottom: 12 }}>✓ 已儲存</div>}
        <Field label="統一結帳日 (1-28)"><input type="number" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} disabled={busy} /></Field>
        <Field label="逾期天數"><input type="number" value={overdue} onChange={(e) => setOverdue(e.target.value)} disabled={busy} /></Field>
        <Field label="截圖保存月數 (retention)"><input type="number" value={retention} onChange={(e) => setRetention(e.target.value)} disabled={busy} /></Field>
        <Field label="Discord Guild ID"><input value={guild} onChange={(e) => setGuild(e.target.value)} disabled={busy} /></Field>
        <Field label="Discord 繳費頻道 ID"><input value={channel} onChange={(e) => setChannel(e.target.value)} disabled={busy} /></Field>
        <Field label="可發起繳費的管理員 Discord ID（逗號分隔）"><input value={adminIds} onChange={(e) => setAdminIds(e.target.value)} disabled={busy} /></Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <input type="checkbox" checked={delMsg} onChange={(e) => setDelMsg(e.target.checked)} disabled={busy} /> 刪除 Discord 原始繳費訊息
        </label>
        <button className="btn btn--primary" onClick={save} disabled={busy}>儲存設定</button>

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">常駐繳費訊息</div>
        <RebuildMessage />

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <InitiateBilling />

        <ImportRoster />
      </div>
    </Card>
  );
}

function ImportRoster() {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (!file) { setErr("請選擇 CSV 檔"); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.importMembers(file, start || undefined);
      const s = r.summary;
      setMsg(`✓ 建立 ${s.usersCreated} 人 / 更新 ${s.usersUpdated} 人 / 新增 ${s.subsCreated} 訂閱 / 跳過 ${s.subsSkipped} 訂閱 / 略過 ${s.rowsSkipped} 列` +
        (s.unmatchedPlans.length ? ` · 對不到的方案：${s.unmatchedPlans.join(", ")}` : ""));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
      <div className="field__label">匯入名單（CSV）</div>
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 10px" }}>欄位需為「姓名, 帳號, 方案名…」；方案名須與系統方案一致。空白＝起算當月。</p>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
      <div style={{ marginTop: 10 }}>
        <Field label="起算月份第一天（選填，YYYY-MM-DD）"><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01" disabled={busy} /></Field>
      </div>
      <button className="btn btn--primary" onClick={run} disabled={busy}>匯入</button>
    </>
  );
}

function InitiateBilling() {
  const plans = useAsync(() => api.plans(), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="field__label">發起繳費</div>
      <button className="btn" onClick={() => setOpen(true)}>確認本期金額並發出開繳通知</button>
      {open && plans.data && <InitiateModal plans={plans.data.plans.filter((p) => p.active)} onClose={() => setOpen(false)} />}
    </>
  );
}

function InitiateModal({ plans, onClose }: { plans: { id: number; name: string; monthly_amount: number }[]; onClose: () => void }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(plans.map((p) => [p.id, String(p.monthly_amount)])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.initiateBilling({
        period,
        amounts: plans.map((p) => ({ plan_id: p.id, amount: Number(amounts[p.id]) })),
      });
      setMsg(r.sent ? `✓ 已發出通知（更新 ${r.updated_plans} 方案 / ${r.updated_payments} 筆）` : `✓ 已更新金額（通知先前已發送）`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <Modal title="發起繳費" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>修改金額即為該方案的新定價（下期沿用）；已繳／已驗證的紀錄不受影響。</p>
      <Field label="期別"><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" disabled={busy} /></Field>
      {plans.map((p) => (
        <Field key={p.id} label={`${p.name} 金額`}>
          <input type="number" value={amounts[p.id] ?? ""} onChange={(e) => setAmounts((s) => ({ ...s, [p.id]: e.target.value }))} disabled={busy} />
        </Field>
      ))}
      <button className="btn btn--primary" onClick={run} disabled={busy}>發起並通知</button>
    </Modal>
  );
}

function RebuildMessage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.rebuildPaymentMessage(); setMsg(`✓ 已建立/更新（訊息 id ${r.message_id}）`); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <button className="btn" onClick={run} disabled={busy}>於 #繳費頻道 建立/重建「繳費」按鈕訊息</button>
    </>
  );
}
