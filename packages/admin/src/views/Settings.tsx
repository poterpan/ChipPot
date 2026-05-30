import { useEffect, useState } from "react";
import { api } from "../api";
import { useAsync, Card, Field, Empty } from "../ui";

export function Settings() {
  const { data, loading, error } = useAsync(() => api.workspace(), []);
  const [billingDay, setBillingDay] = useState("5");
  const [overdue, setOverdue] = useState("3");
  const [retention, setRetention] = useState("24");
  const [delMsg, setDelMsg] = useState(false);
  const [guild, setGuild] = useState("");
  const [channel, setChannel] = useState("");
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
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <input type="checkbox" checked={delMsg} onChange={(e) => setDelMsg(e.target.checked)} disabled={busy} /> 刪除 Discord 原始繳費訊息
        </label>
        <button className="btn btn--primary" onClick={save} disabled={busy}>儲存設定</button>
      </div>
    </Card>
  );
}
