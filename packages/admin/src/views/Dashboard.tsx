import { useState } from "react";
import { api, periodForBillingDay } from "../api";
import { useAsync, Card, Stat, Empty, Money } from "../ui";

function PushStatus({ period }: { period: string }) {
  const { data, reload } = useAsync(() => api.notifications(period), [period]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key); setMsg(null);
    try { await fn(); reload(); setMsg("✓ 完成"); } catch (e) { setMsg((e as Error).message); }
    setBusy(null);
  }
  const Row = ({ label, type, sentAt }: { label: string; type: string; sentAt: string | null | undefined }) => (
    <tr>
      <td>{label}</td>
      <td className="mono" style={{ fontSize: 12.5 }}>{sentAt ? `已發送 ${sentAt}` : "未發送"}</td>
      <td className="right">
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resendNotification(type, period), `r${type}`)}>{busy === `r${type}` ? "…" : "立即重發"}</button>{" "}
        <button className="btn" disabled={!!busy} onClick={() => act(() => api.resetNotification(type, period), `x${type}`)}>{busy === `x${type}` ? "…" : "重置"}</button>
      </td>
    </tr>
  );
  return (
    <Card title="推播狀態">
      {msg && <div style={{ color: "var(--teal)", padding: "8px 20px" }}>{msg}</div>}
      <div className="tbl">
        <table>
          <thead><tr><th>通知</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            <Row label="開繳通知" type="billing_opened" sentAt={data?.billing_opened?.sent_at} />
            <Row label="逾期催繳" type="overdue" sentAt={data?.overdue?.sent_at} />
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Dashboard() {
  const ws = useAsync(() => api.workspace(), []);
  const billingDay = (ws.data as any)?.workspace?.billing_day ?? 1;
  // null = "follow the billing-day-aware default"; a string = the admin typed a period.
  const [period, setPeriod] = useState<string | null>(null);
  const effPeriod = period ?? periodForBillingDay(billingDay);
  const { data, loading, error } = useAsync(() => api.reconcile(effPeriod), [effPeriod]);

  return (
    <>
      <div className="toolbar">
        <label>
          期別{" "}
          <input type="month" value={effPeriod} onChange={(e) => setPeriod(e.target.value)} style={{ width: 160 }} />
        </label>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && <Empty>載入中…</Empty>}
      {data && (
        <>
          <div className="stats">
            <Stat label="待繳" value={data.status_counts.pending} />
            <Stat label="已繳待驗" value={data.status_counts.paid} />
            <Stat label="已驗證" value={data.status_counts.verified} accent />
            <Stat label="已退回" value={data.status_counts.rejected} />
            <Stat label="應收總額" value={`NT$${data.total_amount_due.toLocaleString()}`} />
            <Stat label="已驗證金額" value={`NT$${data.verified_amount.toLocaleString()}`} accent />
            <Stat label="無憑證(已繳)" value={data.no_proof_count} />
          </div>

          <Card title="各方案">
            <div className="tbl">
              <table>
                <thead>
                  <tr><th>方案</th><th className="right">筆數</th><th className="right">待繳</th><th className="right">已繳</th><th className="right">已驗證</th><th className="right">應收</th><th className="right">已驗證金額</th></tr>
                </thead>
                <tbody>
                  {data.by_plan.length === 0 && <tr><td colSpan={7}><Empty>本期尚無資料</Empty></td></tr>}
                  {data.by_plan.map((p) => (
                    <tr key={p.plan_id}>
                      <td>{p.plan_name}</td>
                      <td className="right mono">{p.total}</td>
                      <td className="right mono">{p.pending}</td>
                      <td className="right mono">{p.paid}</td>
                      <td className="right mono">{p.verified}</td>
                      <td className="right"><Money v={p.amount_due} /></td>
                      <td className="right"><Money v={p.amount_verified} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <PushStatus period={effPeriod} />

          <Card title="依渠道分組（已驗證）">
            <div className="tbl">
              <table>
                <thead><tr><th>渠道</th><th className="right">筆數</th><th className="right">金額</th></tr></thead>
                <tbody>
                  {data.by_channel_tag.length === 0 && <tr><td colSpan={3}><Empty>本期尚無已驗證款項</Empty></td></tr>}
                  {data.by_channel_tag.map((t, i) => (
                    <tr key={i}>
                      <td>{t.channel_tag_name ?? "（未指定）"}</td>
                      <td className="right mono">{t.count}</td>
                      <td className="right"><Money v={t.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
