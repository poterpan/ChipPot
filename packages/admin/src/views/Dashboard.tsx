import { useEffect, useState } from "react";
import { api, periodForBillingDay, type ReconcileDiff } from "../api";
import { useAsync, Card, Stat, Empty, Money, Modal } from "../ui";

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
  const { data, loading, error, reload } = useAsync(() => api.reconcile(effPeriod), [effPeriod]);
  const [sync, setSync] = useState(false);

  return (
    <>
      <div className="toolbar">
        <label>
          期別{" "}
          <input type="month" value={effPeriod} onChange={(e) => setPeriod(e.target.value)} style={{ width: 160 }} />
        </label>
        <div className="grow" style={{ flex: 1 }} />
        <button className="btn btn--primary" onClick={() => setSync(true)}>重新同步本期帳單</button>
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
      {sync && <SyncModal key={effPeriod} period={effPeriod} onClose={() => setSync(false)} onDone={() => reload()} />}
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
