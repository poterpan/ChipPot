import { useEffect, useState } from "react";
import { ApiError, api, NOTIFY_REASON_TEXT, type ResendBillingPreview, type OverduePreview } from "../api";
import { useAsync, Card, Modal, Stat, Empty, ConfirmDanger } from "../ui";
import { DiffList } from "../components/DiffList";

/**
 * 推播狀態 — the dashboard's outward-facing actions. Every one of them posts to a public channel or
 * clears a dedup log, so each goes through the project's two-step shape (preview → named red
 * confirm → report the real numbers), the same as SyncModal / RetractModal.
 *
 * There is deliberately NO "重置" for 開繳通知: that row IS the definition of "this period is open"
 * (worker core/notify.ts isBillingOpened), so deleting it alone leaves every bill standing in a
 * period nobody can pay. The whole operation is 收回本期開繳 on the payments page; the note below
 * the table points there, and the API returns 409 if anything tries anyway.
 */
export function PushStatus({ period }: { period: string }) {
  const { data, error, reload } = useAsync(() => api.notifications(period), [period]);
  const [open, setOpen] = useState<"resend" | "overdue" | "reset" | null>(null);

  // 未發送 is a claim, so it is only ever printed when the fetch actually said so. Without data the
  // card says it does not know, and every button here is held: each one either posts to the public
  // channel or lets the cron post again, and the modal's dry-run cannot guard the gap because the
  // API that just failed is the same one it would ask.
  const unknown = error ? "狀態不明" : data ? null : "載入中…";
  const sentLabel = (at: string | null | undefined) => unknown ?? (at ? `已發送 ${at}` : "未發送");
  const holdReason = error
    ? "目前讀不到推播狀態，無法確認是否已經發送過——請先重試。"
    : data ? undefined : "推播狀態載入中…";

  const close = () => setOpen(null);
  const done = () => { reload(); };

  return (
    <Card title="推播狀態">
      {error && (
        <div style={{ padding: "14px 20px 0" }}>
          <div className="error-banner" style={{ marginBottom: 0, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <span>讀不到推播狀態：{error}</span>
            <button className="btn" onClick={reload}>重試</button>
          </div>
        </div>
      )}
      <div className="tbl tbl--pin-last">
        <table className="tbl-cards">
          <thead><tr><th>通知</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td data-label="通知">開繳通知</td>
              <td data-label="狀態" className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.billing_opened?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" disabled={!!holdReason} title={holdReason} onClick={() => setOpen("resend")}>重發開繳通知…</button>
              </td>
            </tr>
            <tr>
              <td data-label="通知">逾期催繳</td>
              <td data-label="狀態" className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.overdue?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" disabled={!!holdReason} title={holdReason} onClick={() => setOpen("overdue")}>催繳未繳成員…</button>{" "}
                <button className="btn btn--danger" disabled={!!holdReason} title={holdReason} onClick={() => setOpen("reset")}>重置催繳發送紀錄…</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ color: "var(--muted-strong)", fontSize: 12.5, lineHeight: 1.7, padding: "10px 20px 16px", margin: 0 }}>
        要把 {period} 改回「未開繳」（成員暫時無法繳費）？請到「繳費審核」使用<b>收回本期開繳</b> ——
        它會一併刪掉未繳／已退回的帳單，不會只留下對不起來的半套狀態。
      </p>

      {open === "resend" && <ResendBillingModal period={period} onClose={close} onDone={done} />}
      {open === "overdue" && <OverdueModal period={period} onClose={close} onDone={done} />}
      {open === "reset" && <ResetOverdueModal period={period} onClose={close} onDone={done} />}
    </Card>
  );
}

/**
 * Which screen one dry-run answer maps to. Every response has to land in exactly one of these:
 * a body this build cannot read becomes "skew" instead of matching no branch at all and leaving an
 * empty dialog. That was not hypothetical — the deployed worker (origin/main routes/admin.ts)
 * answers `{ ok, sent }` / `{ ok, count }` with no `outcome` field, so against it every branch was
 * false and the modal rendered blank.
 */
type View<T> = { k: "preview"; p: T } | { k: "blocked"; o: string } | { k: "skew" };

function classify<T extends { outcome?: string }>(r: T | null | undefined): View<T> {
  if (r && r.outcome === "preview") return { k: "preview", p: r };
  // An outcome this build has no sentence for still prints its raw key rather than nothing, so a
  // future enum member degrades to something readable instead of a blank modal.
  if (r && typeof r.outcome === "string" && r.outcome.length > 0) return { k: "blocked", o: r.outcome };
  return { k: "skew" };
}

/**
 * Shown when the worker's answer is not one this build understands. Worded as a warning rather than
 * an error because the likeliest cause is a worker older than this bundle — one that ignores
 * `dry_run` and has therefore ALREADY posted to the channel on what this screen called a preview.
 */
const SKEW_PREVIEW = "後端回應的格式不是這個版本的後台認得的（可能後端版本較舊、還不支援預覽）。它可能已經直接送出通知了——請對照上方的發送時間與 Discord 頻道，不要重複操作。";
const SKEW_RESULT = "無法確認結果：後端回應的格式不是這個版本的後台認得的。請對照上方的發送時間與 Discord 頻道確認。";

/** 重發開繳通知 — re-posts an existing notice. Never creates bills, never changes prices. */
function ResendBillingModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [view, setView] = useState<View<ResendBillingPreview> | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("billing_opened", period, { dry_run: true })
      .then((r) => {
        if (off) return;
        const v = classify(r as ResendBillingPreview);
        setView(v);
        setBusy(false);
        // A worker that answers in an unknown shape may have acted on this "preview", so refresh the
        // card instead of leaving its 已發送 time asserting something that is no longer true.
        if (v.k === "skew") onDone();
      })
      .catch((e) => {
        if (off) return;
        // 未開繳 never arrives as a 200 outcome: the route turns it into a 409 (worker
        // routes/admin.ts notificationsResend), so it lands here instead.
        if (e instanceof ApiError && e.status === 409) setView({ k: "blocked", o: "not_opened" });
        else setErr((e as Error).message);
        setBusy(false);
      });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.resendNotification("billing_opened", period, { dry_run: false }) as ResendBillingPreview;
      setResult(classify(r).k === "skew" ? SKEW_RESULT
        : r.sent ? `✓ 已在頻道重發 ${period} 開繳通知（列出 ${r.lines.length} 個方案）。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`重發開繳通知 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !view && <Empty>檢查中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {!result && view?.k === "blocked" && (
        <p style={{ color: "var(--muted)" }}>無法重發：{NOTIFY_REASON_TEXT[view.o] ?? view.o}。</p>
      )}
      {!result && view?.k === "skew" && <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>{SKEW_PREVIEW}</p>}
      {!result && view?.k === "preview" && (
        <>
          <div className="stats"><Stat label="📣 公告方案" value={view.p.lines.length} /></div>
          <DiffList title="通知會列出的方案" rows={view.p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`)} />
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            重發只會在繳費頻道再貼一次同樣的開繳通知。<b>不會</b>新增或修改任何帳單、<b>不會</b>改動方案定價，
            期別也全程維持在「已開繳」。成員會再被 @ 一次。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認重發通知</button>
        </>
      )}
    </Modal>
  );
}

/**
 * 催繳未繳成員 — the admin-triggered overdue notice. Named for what it does, because it is NOT the
 * same list as the daily cron: it @s every unpaid member regardless of 逾期天數.
 */
function OverdueModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [view, setView] = useState<View<OverduePreview> | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("overdue", period, { dry_run: true })
      .then((r) => {
        if (off) return;
        const v = classify(r as OverduePreview);
        setView(v);
        setBusy(false);
        if (v.k === "skew") onDone(); // it may already have @-ed the channel — see SKEW_PREVIEW
      })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.resendNotification("overdue", period, { dry_run: false }) as OverduePreview;
      setResult(classify(r).k === "skew" ? SKEW_RESULT
        : r.count > 0 ? `✓ 已在頻道催繳 ${r.count} 位成員。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`催繳未繳成員 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !view && <Empty>計算名單中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {!result && view?.k === "blocked" && (
        <p style={{ color: "var(--muted)" }}>無法催繳：{NOTIFY_REASON_TEXT[view.o] ?? view.o}。</p>
      )}
      {!result && view?.k === "skew" && <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>{SKEW_PREVIEW}</p>}
      {!result && view?.k === "preview" && (
        <>
          <div className="stats">
            <Stat label="🔔 會 @ 的成員" value={view.p.people.length} />
            <Stat label="💰 未繳總額" value={`NT$${view.p.people.reduce((s, p) => s + p.total, 0).toLocaleString()}`} />
          </div>
          <DiffList title="會被 @ 的成員" rows={view.p.people.map((p) => `${p.user_name} NT$${p.total.toLocaleString()}${p.discord_id ? "" : "（未綁定，@ 不到）"}`)} />
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            這會在繳費頻道公開 @ {period} <b>所有</b>未繳成員（含已退回的），<b>不受</b>「逾期天數（{view.p.overdue_days} 天）」限制；
            每日自動催繳只會 @ 已超過逾期天數的人，所以這份名單通常比較長。送出後本期的催繳發送紀錄會更新為現在。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認催繳這 {view.p.people.length} 位</button>
        </>
      )}
    </Modal>
  );
}

/** 重置催繳發送紀錄 — clears ONLY the overdue dedup row. No bills, no open/closed state. */
function ResetOverdueModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [result, setResult] = useState<string | null>(null);
  // ConfirmDanger keeps its busy flag set once onConfirm resolves, so the call-site contract is:
  // reject on failure (it shows the error and re-enables), unmount on success (the result screen
  // below replaces it) — never resolve while still rendered.
  if (result) {
    return (
      <Modal title={`重置催繳發送紀錄 · ${period}`} onClose={onClose}>
        <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>
      </Modal>
    );
  }
  return (
    <ConfirmDanger
      title={`重置催繳發送紀錄 · ${period}`}
      message={`刪除 ${period} 的「逾期催繳」發送紀錄後，每日自動催繳會在下次符合逾期條件時再送一次（同一批人可能被重複 @）。\n\n這只影響催繳的去重紀錄：不會變更任何帳單，也不會影響本期的開繳狀態。`}
      confirmLabel="確認重置"
      busyLabel="重置中…"
      onClose={onClose}
      onConfirm={async () => {
        const r = await api.resetNotification("overdue", period);
        setResult(`✓ 已重置催繳發送紀錄（刪除 ${r.deleted} 筆）。`);
        onDone();
      }}
    />
  );
}
