import { useEffect, useMemo, useRef, useState } from "react";
import { fetchTokenInfo, submitPayment, type TokenInfo } from "./api";
import { compressImage } from "./compress";

type Stage = "loading" | "invalid" | "ready" | "submitting" | "done";

function tokenFromPath(): string | null {
  const m = window.location.pathname.match(/\/u\/([0-9a-fA-F]{16,})/);
  return m ? m[1] : null;
}

export default function App() {
  const token = useMemo(tokenFromPath, []);
  const [stage, setStage] = useState<Stage>("loading");
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) {
      setStage("invalid");
      return;
    }
    fetchTokenInfo(token).then((i) => {
      if (!i.valid) {
        setStage("invalid");
        return;
      }
      setInfo(i);
      setStage("ready");
    });
  }, [token]);

  function onPick(f: File | null) {
    setError(null);
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  const subs = info?.subscriptions ?? [];
  const tags = info?.channel_tags ?? [];
  const total = subs.reduce((s, x) => s + x.amount, 0);
  const canSubmit = !!file || !!note.trim() || channelId != null;

  async function submit() {
    if (!token) return;
    if (!canSubmit) {
      setError("請至少附上截圖、填寫備註，或選擇渠道");
      return;
    }
    setError(null);
    setStage("submitting");
    const blob = file ? await compressImage(file) : null;
    const res = await submitPayment(token, blob, channelId, note);
    if (res.ok) {
      setStage("done");
    } else {
      setError(res.error ?? "上傳失敗");
      setStage("ready");
    }
  }

  if (stage === "loading") {
    return (
      <Shell>
        <div className="loading">載入中…</div>
      </Shell>
    );
  }

  if (stage === "invalid") {
    return (
      <Shell>
        <div className="state">
          <div className="state__mark state__mark--bad">✕</div>
          <h2>連結無效或已過期</h2>
          <p className="muted">
            一次性連結 30 分鐘內有效、且只能使用一次。請回到 Discord 重新點「繳費」按鈕，或使用
            <code> /繳費 </code>指令。
          </p>
        </div>
      </Shell>
    );
  }

  if (stage === "done") {
    return (
      <Shell>
        <div className="state">
          <div className="state__mark state__mark--ok">✓</div>
          <h2>已收到你的繳費</h2>
          <p className="muted">管理員核對後即完成。你可以關閉這個頁面了。</p>
        </div>
      </Shell>
    );
  }

  const busy = stage === "submitting";

  return (
    <Shell>
      <Stub period={info?.period ?? ""} name={info?.user?.display_name ?? ""} subs={subs} total={total} />

      <div className="body">
        {tags.length > 0 && (
          <label className="field">
            <span className="field__label">繳費渠道</span>
            <select
              value={channelId ?? ""}
              disabled={busy}
              onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">（不指定）</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}

        {info?.proof_enabled !== false && (
        <label className={`drop ${preview ? "drop--has" : ""}`}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          {preview ? (
            <img src={preview} alt="預覽" className="drop__img" />
          ) : (
            <div className="drop__hint">
              <span className="drop__icon">＋</span>
              <span>上傳繳費截圖（選填）</span>
              <span className="muted small">PNG / JPG / WebP · 會自動壓縮</span>
            </div>
          )}
        </label>
        )}

        <textarea
          className="note"
          placeholder="備註 — 例如付款方式、轉帳末五碼"
          value={note}
          maxLength={300}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <div className="error">{error}</div>}

        <button className="submit" onClick={submit} disabled={busy || !canSubmit}>
          {busy ? "上傳中…" : "送出繳費"}
        </button>
        <p className="muted small center">{info?.proof_enabled === false ? "渠道或備註至少填一項。" : "渠道、截圖或備註至少填一項。"}此連結僅限你本人本期使用，送出後即失效。</p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="wrap">
      <div className="card">
        <div className="brand">ChipPot</div>
        {children}
      </div>
      <footer className="foot">社團 AI 訂閱 · 代收系統</footer>
    </main>
  );
}

function Stub({
  period,
  name,
  subs,
  total,
}: {
  period: string;
  name: string;
  subs: { id: number; plan_name: string; amount: number }[];
  total: number;
}) {
  return (
    <header className="stub">
      <div className="stub__row">
        <span className="stub__label">期別</span>
        <span className="stub__period">{period}</span>
      </div>
      <div className="stub__hi">嗨，{name || "夥伴"}</div>
      {subs.map((s) => (
        <div key={s.id} className="stub__row stub__row--amt">
          <span className="stub__plan">{s.plan_name}</span>
          <span className="stub__amt">NT${s.amount}</span>
        </div>
      ))}
      {subs.length > 0 && (
        <div className="stub__row stub__row--amt">
          <span className="stub__plan">合計</span>
          <span className="stub__amt">NT${total}</span>
        </div>
      )}
    </header>
  );
}
