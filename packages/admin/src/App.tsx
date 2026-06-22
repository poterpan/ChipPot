import { useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { Payments } from "./views/Payments";
import { Users, Subscriptions, Plans, ChannelTags } from "./views/Manage";
import { Settings } from "./views/Settings";
import { api } from "./api";
import { IconLogout, Modal } from "./ui";

const VIEWS = [
  { id: "dashboard", label: "對帳看板", el: <Dashboard /> },
  { id: "payments", label: "繳費審核", el: <Payments /> },
  { id: "users", label: "成員", el: <Users /> },
  { id: "subscriptions", label: "訂閱", el: <Subscriptions /> },
  { id: "plans", label: "方案", el: <Plans /> },
  { id: "tags", label: "支付渠道", el: <ChannelTags /> },
  { id: "settings", label: "設定", el: <Settings /> },
];

function R2Notice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("chippot.r2NoticeSeen")) return;
    api.workspace().then((w) => { if (w && w.r2_configured === false) setShow(true); }).catch(() => {});
  }, []);
  if (!show) return null;
  const dismiss = () => { localStorage.setItem("chippot.r2NoticeSeen", "1"); setShow(false); };
  return (
    <Modal title="Cloudflare R2 尚未設定" onClose={dismiss}>
      <p>偵測到尚未綁定 R2 儲存空間，以下功能將無法使用：</p>
      <ul style={{ margin: "8px 0 8px 18px" }}>
        <li>成員上傳繳費截圖</li>
        <li>後台檢視繳費截圖</li>
        <li>截圖自動保存清理</li>
      </ul>
      <p className="muted small">不影響：宣告繳費、後台審核、對帳、Discord 通知。如需截圖功能，請在 wrangler.toml 註冊 R2 binding 後重新部署。</p>
      <button className="btn btn--primary" onClick={dismiss}>我知道了</button>
    </Modal>
  );
}

// The hash may carry a query (e.g. "#payments?id=42" from a notification deep link); the view
// id is just the part before "?". Views read their own params from the hash.
function viewFromHash(): string {
  return window.location.hash.slice(1).split("?")[0] || "dashboard";
}

export default function App() {
  const [view, setView] = useState(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;

  return (
    <div className="app">
      <R2Notice />
      <aside className="sidebar">
        <div className="sidebar__brand">ChipPot</div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <button key={v.id} className={v.id === current.id ? "on" : ""} onClick={() => { window.location.hash = v.id; }}>
              {v.label}
            </button>
          ))}
        </nav>
        <a className="sidebar__logout" href="/cdn-cgi/access/logout"><IconLogout /> 登出</a>
        <div className="sidebar__foot">社團 AI 訂閱 · 管理後台</div>
      </aside>
      <main className="main">
        <div className="topbar"><h1>{current.label}</h1></div>
        <div className="content" key={current.id}>{current.el}</div>
      </main>
    </div>
  );
}
