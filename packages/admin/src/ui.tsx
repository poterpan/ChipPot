import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => alive && (setData(d), setLoading(false)))
      .catch((e) => alive && (setError(e.message), setLoading(false)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待繳", paid: "已繳待驗", verified: "已驗證", rejected: "已退回",
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/**
 * payments.source → what a human calls it. DISPLAY ONLY — the stored values stay English
 * (schema CHECK: user / user_slash / user_web / admin_manual / cron). `?? raw` fallback matches
 * the CHANNEL_TYPE_LABEL precedent in Manage.tsx, so an unknown value degrades to itself.
 * `user` is written by nobody today — it is the schema default, so only legacy rows carry it.
 * `cron` covers the daily job AND 發起繳費／同步 (they pass no source), hence 系統建立 not 排程.
 */
export const SOURCE_LABEL: Record<string, string> = {
  user: "Discord（舊版）", user_slash: "Discord", user_web: "網頁上傳",
  admin_manual: "後台補登", cron: "系統建立",
};

export function Money({ v }: { v: number }) {
  return <span className="mono">NT${v.toLocaleString()}</span>;
}

// Focusable descendants, in DOM order. `:not([disabled])` matters — every modal in this app
// disables its controls while a request is in flight, and a trap that cycles onto a disabled
// button silently swallows the Tab.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// Nesting is possible (PaymentDetail opens from MemberReview), so the scroll lock is refcounted
// rather than set/unset per modal.
let openModalCount = 0;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  // Move focus into the sheet on open and hand it back to whatever opened it on close. Without
  // this, a screen reader announces nothing and 12 consecutive Tabs all land on the table behind.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // The bottom sheet leaves ~357px of tappable backdrop at 375px; dragging it used to scroll the
  // page underneath. Locking on <html> covers both scrollers: body on mobile, .main on desktop.
  useEffect(() => {
    openModalCount += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      openModalCount -= 1;
      if (openModalCount === 0) document.documentElement.classList.remove("modal-open");
    };
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((el) => el.offsetParent !== null); // skip anything inside a closed <details>
    if (els.length === 0) { e.preventDefault(); ref.current?.focus(); return; }
    const first = els[0]!, last = els[els.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 id={titleId}>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

/**
 * The one confirmation shape for a destructive-but-reversible action (deleting a row, clearing a
 * send log, unbinding). Irreversible or outward-facing actions get the two-step preview modal
 * instead (SyncModal / RetractModal / InitiateModal). Both use `btn--danger` — there is exactly one
 * red in this app (`--red`), and `window.confirm` is not used anywhere.
 */
export function ConfirmDanger({ title, message, confirmLabel = "確認刪除", busyLabel = "處理中…", onClose, onConfirm }: {
  title: string; message: string; confirmLabel?: string; busyLabel?: string;
  onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { await onConfirm(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <p style={{ whiteSpace: "pre-wrap", marginBottom: 16, lineHeight: 1.7 }}>{message}</p>
      <div className="btn-row">
        <button className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button className="btn btn--danger" onClick={go} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Card({ title, action, desc, children }: { title: string; action?: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__head-main"><h2>{title}</h2>{desc != null && <div className="card__head-desc">{desc}</div>}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat${accent ? " stat--accent" : ""}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
    </div>
  );
}

// ── Icons (monochrome SVG, inherit color via currentColor — no emoji) ──────────
function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round"
      style={{ verticalAlign: "-0.15em", flexShrink: 0 }} aria-hidden="true">
      {children}
    </svg>
  );
}
export function IconLogout({ size = 16 }: { size?: number }) {
  return <Svg size={size}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></Svg>;
}
export function IconCheck({ size = 14 }: { size?: number }) {
  return <Svg size={size}><path d="M20 6 9 17l-5-5" /></Svg>;
}
export function IconWarning({ size = 14 }: { size?: number }) {
  return <Svg size={size}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Svg>;
}
export function IconX({ size = 13 }: { size?: number }) {
  return <Svg size={size}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>;
}

// useAsync has always returned `reload` and no error UI ever used it: a failed load left a red
// line and no way forward. The 401/403 case is special — api.ts turns it into 未授權，請重新登入，
// but Cloudflare Access only re-issues a session on a fresh page load, so that button reloads.
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const needsLogin = message.includes("重新登入");
  return (
    <div className="error-banner error-banner--act" role="alert">
      <span>{message}</span>
      {needsLogin
        ? <button className="btn" onClick={() => window.location.reload()}>重新登入</button>
        : onRetry && <button className="btn" onClick={onRetry}>重試</button>}
    </div>
  );
}

// ── long-list pickers ─────────────────────────────────────────────────────────
// Below this many options a native <select> is fine on a phone; above it, scrolling a few hundred
// names in the platform picker is the problem the Discord side solved with autocomplete + a search
// modal (handler.ts:306-366). Same idea, simplest possible form: a filter in front of the select.
const FILTER_THRESHOLD = 12;

export function FilterSelect({ label, value, onChange, options, placeholder = "選擇…", disabled }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string; disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : [...options];
  // Keep the current choice selectable even when the filter excludes it, or the select would
  // render blank and the next submit would silently send a stale value.
  if (value && !shown.some((o) => o.value === value)) {
    const cur = options.find((o) => o.value === value);
    if (cur) shown.unshift(cur);
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={`${id}-select`}>{label}</label>
      {options.length > FILTER_THRESHOLD && (
        <input className="fsel__q" type="search" value={q} disabled={disabled}
          placeholder={`搜尋${label}…`} aria-label={`搜尋${label}`}
          onChange={(e) => setQ(e.target.value)} />
      )}
      <select id={`${id}-select`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {shown.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {needle && <span className="field__hint">顯示 {shown.length} / {options.length}</span>}
    </div>
  );
}

// The same filter in a card head, narrowing a rendered table instead of an <option> list.
export function TableFilter({ value, onChange, placeholder, shown, total }: {
  value: string; onChange: (v: string) => void; placeholder: string; shown: number; total: number;
}) {
  return (
    <span className="cardtools">
      <input className="fsel__q" type="search" value={value} placeholder={placeholder}
        aria-label={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value.trim() && <span className="field__hint">{shown} / {total}</span>}
    </span>
  );
}
