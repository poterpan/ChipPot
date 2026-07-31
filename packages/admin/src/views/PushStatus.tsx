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
  const { data, reload } = useAsync(() => api.notifications(period), [period]);
  const [open, setOpen] = useState<"resend" | "overdue" | "reset" | null>(null);

  const sentLabel = (at: string | null | undefined) => (at ? `已發送 ${at}` : "未發送");
  const close = () => setOpen(null);
  const done = () => { reload(); };

  return (
    <Card title="推播狀態">
      <div className="tbl">
        <table>
          <thead><tr><th>通知</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td>開繳通知</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.billing_opened?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" onClick={() => setOpen("resend")}>重發開繳通知…</button>
              </td>
            </tr>
            <tr>
              <td>逾期催繳</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{sentLabel(data?.overdue?.sent_at)}</td>
              <td className="right">
                <button className="btn btn--danger" onClick={() => setOpen("overdue")}>催繳未繳成員…</button>{" "}
                <button className="btn btn--danger" onClick={() => setOpen("reset")}>重置催繳發送紀錄…</button>
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

/** 重發開繳通知 — re-posts an existing notice. Never creates bills, never changes prices. */
function ResendBillingModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<ResendBillingPreview | null>(null);
  // The outcome key when nothing can be re-posted — rendered as a plain sentence with no red button,
  // never as an error banner: "此期尚未開繳" is a state of this screen, not a failure.
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("billing_opened", period, { dry_run: true })
      .then((r) => {
        if (off) return;
        const p = r as ResendBillingPreview;
        if (p.outcome === "preview") setPreview(p); else setBlocked(p.outcome);
        setBusy(false);
      })
      .catch((e) => {
        if (off) return;
        // 未開繳 never arrives as a 200 outcome: the route turns it into a 409 (worker
        // routes/admin.ts notificationsResend), so it lands here instead.
        if (e instanceof ApiError && e.status === 409) setBlocked("not_opened");
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
      setResult(r.sent
        ? `✓ 已在頻道重發 ${period} 開繳通知（列出 ${r.lines.length} 個方案）。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`重發開繳通知 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !preview && !blocked && <Empty>檢查中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {blocked && !result && (
        <p style={{ color: "var(--muted)" }}>無法重發：{NOTIFY_REASON_TEXT[blocked] ?? blocked}。</p>
      )}
      {preview && !result && (
        <>
          <div className="stats"><Stat label="📣 公告方案" value={preview.lines.length} /></div>
          <DiffList title="通知會列出的方案" rows={preview.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`)} />
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
  const [preview, setPreview] = useState<OverduePreview | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    api.resendNotification("overdue", period, { dry_run: true })
      .then((r) => {
        if (off) return;
        const p = r as OverduePreview;
        if (p.outcome === "preview") setPreview(p); else setBlocked(p.outcome);
        setBusy(false);
      })
      .catch((e) => { if (!off) { setErr((e as Error).message); setBusy(false); } });
    return () => { off = true; };
  }, [period]);

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.resendNotification("overdue", period, { dry_run: false }) as OverduePreview;
      setResult(r.count > 0
        ? `✓ 已在頻道催繳 ${r.count} 位成員。`
        : `未發送：${NOTIFY_REASON_TEXT[r.outcome] ?? r.outcome}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={`催繳未繳成員 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {busy && !preview && !blocked && <Empty>計算名單中…</Empty>}
      {result && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{result}</div>}
      {blocked && !result && (
        <p style={{ color: "var(--muted)" }}>無法催繳：{NOTIFY_REASON_TEXT[blocked] ?? blocked}。</p>
      )}
      {preview && !result && (
        <>
          <div className="stats">
            <Stat label="🔔 會 @ 的成員" value={preview.people.length} />
            <Stat label="💰 未繳總額" value={`NT$${preview.people.reduce((s, p) => s + p.total, 0).toLocaleString()}`} />
          </div>
          <DiffList title="會被 @ 的成員" rows={preview.people.map((p) => `${p.user_name} NT$${p.total.toLocaleString()}${p.discord_id ? "" : "（未綁定，@ 不到）"}`)} />
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            這會在繳費頻道公開 @ {period} <b>所有</b>未繳成員（含已退回的），<b>不受</b>「逾期天數（{preview.overdue_days} 天）」限制；
            每日自動催繳只會 @ 已超過逾期天數的人，所以這份名單通常比較長。送出後本期的催繳發送紀錄會更新為現在。
          </p>
          <button className="btn btn--danger" disabled={busy} onClick={apply}>確認催繳這 {preview.people.length} 位</button>
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
