import { useEffect, useState, type ReactNode } from "react";

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
  pending: "待繳", paid: "已繳", verified: "已驗證", rejected: "已退回",
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Money({ v }: { v: number }) {
  return <span className="mono">NT${v.toLocaleString()}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
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
