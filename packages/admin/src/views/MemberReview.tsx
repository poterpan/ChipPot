import { useState } from "react";
import { api, nudgeSummary, type ChannelTag, type Payment } from "../api";
import { useAsync, Card, Empty, Money, StatusBadge, IconCheck, IconWarning } from "../ui";
import { PaymentDetail } from "./PaymentDetail";

/**
 * Aggregate review for ONE member × ONE period — where a payment-submission notification lands
 * (#payments?user=<id>&period=<YYYY-MM>). One member submit settles one payment row per active
 * subscription, all sharing one screenshot, so this shows the screenshot once and lets the owner
 * approve the whole period with a single tap (一鍵全部核准); per-row 核准／退回 stay available for
 * the mixed cases. Laid out mobile-first: everything stacks, actions are thumb-sized.
 */
export function MemberReview({ userId, period, tags, onBack }: {
  userId: number; period: string; tags: ChannelTag[]; onBack: () => void;
}) {
  const list = useAsync(() => api.payments({ user_id: userId, period }), [userId, period]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [nudged, setNudged] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Payment | null>(null);

  const rows = list.data?.payments ?? [];
  const name = rows[0]?.user_name ?? `#${userId}`;
  const reviewable = rows.filter((p) => p.status === "paid"); // 已繳待驗 — exactly what verify-all sweeps
  // Rows the bulk sweep leaves alone, so the button and its result never overstate 「全部」.
  const outstanding = rows.filter((p) => p.status === "pending" || p.status === "rejected");
  const total = rows.reduce((s, p) => s + p.amount, 0);
  // One submit shares one screenshot key across every settled row — render each distinct proof once.
  const proofKeys = [...new Set(rows.filter((p) => p.has_proof && p.screenshot_key).map((p) => p.screenshot_key!))];
  const proofExpired = proofKeys.length === 0 && rows.some((p) => p.has_proof === 1 && p.proof_deleted_at);
  // 純聲明 only means something once something was submitted; an all-待繳 period simply has nothing yet.
  const submitted = rows.some((p) => ["paid", "verified"].includes(p.status));
  const notes = [...new Set(rows.map((p) => p.payment_note).filter((n): n is string => !!n))];

  async function run(fn: () => Promise<string | null>) {
    setBusy(true); setErr(null); setDone(null);
    try { setDone(await fn()); }
    catch (e) { setErr((e as Error).message); }
    // Reload on failure too: 一鍵全部核准 commits row by row, so an aborted batch really did verify
    // part of the list (the banner says how many) and the rows must not stay stale.
    list.reload();
    setBusy(false);
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={onBack}>← 返回繳費列表</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      {list.error && <div className="error-banner">{list.error}</div>}

      <div className="mreview__head">
        <h2 className="mreview__title">{name}</h2>
        <span className="mreview__meta mono">{period}</span>
        {rows.length > 0 && <span className="mreview__meta">共 {rows.length} 筆 · 合計 <Money v={total} /></span>}
      </div>

      {list.loading && <Empty>載入中…</Empty>}
      {!list.loading && !list.error && rows.length === 0 && <Empty>這位成員在 {period} 沒有繳費紀錄。</Empty>}

      {rows.length > 0 && (
        <>
          <Card title="繳費憑證">
            <div className="mreview__body">
              {proofKeys.map((k) => <img key={k} className="proof-img" src={api.imageUrl(k)} alt="繳費截圖" />)}
              {proofExpired && <p className="mreview__note">截圖已依保存期刪除（對帳資料保留）。</p>}
              {proofKeys.length === 0 && !proofExpired && (
                submitted
                  ? <p className="mreview__note mreview__note--warn"><IconWarning /> 無憑證，純聲明 — 請依備註與帳戶自行核對。</p>
                  : <p className="mreview__note">本期尚未回報繳費。</p>
              )}
              {notes.length > 0 && <p className="mreview__note">成員備註：{notes.join("；")}</p>}
            </div>
          </Card>

          <div className="mreview__bulk">
            <button
              className="btn btn--primary iconlbl"
              disabled={busy || reviewable.length === 0}
              onClick={() => run(async () => {
                const r = await api.verifyAll(userId, period);
                return outstanding.length > 0
                  ? `已核准 ${r.verified} 筆，另 ${outstanding.length} 筆（待繳／已退回）需逐筆處理`
                  : `已核准 ${r.verified} 筆`;
              })}
            >
              {/* 全部 is only true when every row is 已繳待驗; otherwise name the subset the sweep covers. */}
              <IconCheck />{busy ? "處理中…" : outstanding.length > 0
                ? `核准已繳待驗（${reviewable.length} 筆）`
                : `一鍵全部核准（${reviewable.length} 筆）`}
            </button>
            {outstanding.length > 0 && (
              <button
                className="btn"
                disabled={busy}
                title="在帳單頻道 @ 這位成員，列出他這一期還沒繳的項目"
                onClick={() => run(async () => {
                  // force: the admin is deliberately asking for another ping, which is the one
                  // sanctioned way past the per-period nudge dedup (core/nudge.ts).
                  const r = await api.nudgeMembers({ period, user_ids: [userId], kind: "remind", force: true });
                  setNudged(nudgeSummary(r));
                  return null;
                })}
              >
                催繳這位成員（{outstanding.length} 筆未繳）
              </button>
            )}
            {nudged && <span className="mreview__meta">{nudged}</span>}
            {!busy && !done && reviewable.length === 0 && <span className="mreview__meta">目前沒有已繳待驗的紀錄</span>}
            {done && <span className="mreview__ok"><IconCheck />{done}</span>}
          </div>

          <Card title="逐筆明細">
            {rows.map((p) => (
              <div className="mrow" key={p.id}>
                <div className="mrow__main">
                  <div className="mrow__top">
                    <span className="mrow__plan">{p.plan_name}</span>
                    <Money v={p.amount} />
                  </div>
                  <div className="mrow__facts">
                    <StatusBadge status={p.status} />
                    <span>申報渠道：{p.declared_channel_tag_name ?? "未指定"}</span>
                    <button className="linkbtn" onClick={() => setSelected(p)}>完整資訊</button>
                  </div>
                </div>
                <div className="mrow__acts">
                  {["pending", "paid", "rejected"].includes(p.status) && (
                    <button className="btn iconlbl" disabled={busy} title="標記已驗證（帶入申報渠道）"
                      onClick={() => run(async () => { await api.verify(p.id, null); return null; })}>
                      <IconCheck />核准
                    </button>
                  )}
                  {["pending", "paid"].includes(p.status) && (
                    <button className="btn btn--danger" disabled={busy}
                      onClick={() => { setRejecting(rejecting === p.id ? null : p.id); setReason(""); }}>退回</button>
                  )}
                </div>
                {rejecting === p.id && (
                  <div className="mrow__reject">
                    <input aria-label="退回原因" placeholder="退回原因（選填）" value={reason} disabled={busy}
                      onChange={(e) => setReason(e.target.value)} />
                    <button className="btn btn--danger" disabled={busy}
                      onClick={() => run(async () => { await api.reject(p.id, reason); setRejecting(null); setReason(""); return null; })}>確認退回</button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </>
      )}

      {selected && (
        <PaymentDetail
          payment={selected}
          tags={tags}
          onClose={() => setSelected(null)}
          onDone={() => { setSelected(null); list.reload(); }}
        />
      )}
    </>
  );
}
