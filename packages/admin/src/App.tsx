import { useEffect, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { Payments } from "./views/Payments";
import { Users, Subscriptions, Plans, ChannelTags } from "./views/Manage";
import { Settings } from "./views/Settings";

const VIEWS = [
  { id: "dashboard", label: "對帳看板", el: <Dashboard /> },
  { id: "payments", label: "繳費審核", el: <Payments /> },
  { id: "users", label: "成員", el: <Users /> },
  { id: "subscriptions", label: "訂閱", el: <Subscriptions /> },
  { id: "plans", label: "方案", el: <Plans /> },
  { id: "tags", label: "渠道 Tag", el: <ChannelTags /> },
  { id: "settings", label: "設定", el: <Settings /> },
];

export default function App() {
  const [view, setView] = useState(() => window.location.hash.slice(1) || "dashboard");
  useEffect(() => {
    const onHash = () => setView(window.location.hash.slice(1) || "dashboard");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">ChipPot</div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <button key={v.id} className={v.id === current.id ? "on" : ""} onClick={() => { window.location.hash = v.id; }}>
              {v.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">社團 AI 訂閱 · 管理後台</div>
      </aside>
      <main className="main">
        <div className="topbar"><h1>{current.label}</h1></div>
        <div className="content" key={current.id}>{current.el}</div>
      </main>
    </div>
  );
}
