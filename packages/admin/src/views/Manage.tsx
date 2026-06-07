import { useState } from "react";
import { api, type User, type Plan, type ChannelTag, type Subscription } from "../api";
import { useAsync, Card, Modal, Field, Empty } from "../ui";

function useForm<T extends Record<string, any>>(initial: T) {
  const [v, setV] = useState<T>(initial);
  return [v, (k: keyof T, val: any) => setV((s) => ({ ...s, [k]: val }))] as const;
}

function ConfirmDelete({ title, message, onClose, onConfirm }: { title: string; message: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { await onConfirm(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <p style={{ whiteSpace: "pre-wrap", marginBottom: 16 }}>{message}</p>
      <button className="btn" onClick={onClose} disabled={busy} style={{ marginRight: 8 }}>取消</button>
      <button className="btn btn--primary" onClick={go} disabled={busy} style={{ background: "var(--danger, #c0392b)", borderColor: "var(--danger, #c0392b)" }}>{busy ? "刪除中…" : "確認刪除"}</button>
    </Modal>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────
export function Users() {
  const { data, loading, error, reload } = useAsync(() => api.users(), []);
  const [edit, setEdit] = useState<User | null | undefined>(undefined); // undefined=closed, null=new
  const [del, setDel] = useState<User | null>(null);
  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <Card title="成員" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增成員</button>}>
        <div className="tbl">
          <table>
            <thead><tr><th>名稱</th><th>Discord ID</th><th>Email</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4}><Empty>載入中…</Empty></td></tr>}
              {data?.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.display_name}</td><td className="mono" style={{ fontSize: 12.5 }}>{u.discord_id ?? "—"}</td><td>{u.email ?? "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(u)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(u)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <UserModal user={edit} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDelete
          title={`刪除成員 · ${del.display_name}`}
          message={`將一併刪除此成員的 ${del.subscription_count ?? 0} 個訂閱、${del.payment_count ?? 0} 筆繳費紀錄。\n此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteUser(del.id); setDel(null); reload(); }}
        />
      )}
    </>
  );
}
function UserModal({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
  const [f, set] = useForm({ display_name: user?.display_name ?? "", discord_id: user?.discord_id ?? "", email: user?.email ?? "", note: user?.note ?? "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.display_name) { setErr("請填名稱"); return; }
    setBusy(true); setErr(null);
    try {
      const body = { display_name: f.display_name, discord_id: f.discord_id || undefined, email: f.email || undefined, note: f.note || undefined };
      if (user) await api.updateUser(user.id, body); else await api.createUser(body);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={user ? "編輯成員" : "新增成員"} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="名稱"><input value={f.display_name} onChange={(e) => set("display_name", e.target.value)} disabled={busy} /></Field>
      <Field label="Discord ID"><input value={f.discord_id} onChange={(e) => set("discord_id", e.target.value)} disabled={busy} /></Field>
      <Field label="Email"><input value={f.email} onChange={(e) => set("email", e.target.value)} disabled={busy} /></Field>
      <Field label="備註"><input value={f.note} onChange={(e) => set("note", e.target.value)} disabled={busy} /></Field>
      <button className="btn btn--primary" onClick={save} disabled={busy}>儲存</button>
    </Modal>
  );
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function Subscriptions() {
  const { data, loading, error, reload } = useAsync(() => api.subscriptions(), []);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Subscription | null>(null);
  const [del, setDel] = useState<Subscription | null>(null);
  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <Card title="訂閱" action={<button className="btn btn--primary" onClick={() => setAdd(true)}>新增訂閱</button>}>
        <div className="tbl">
          <table>
            <thead><tr><th>成員</th><th>方案</th><th>狀態</th><th>起算日</th><th className="right">結帳日</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {data?.subscriptions.map((s) => (
                <tr key={s.id}>
                  <td>{s.user_name}</td><td>{s.plan_name}</td><td>{s.status}</td><td className="mono">{s.start_date}</td><td className="right mono">{s.billing_day}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(s)}>編輯</button>{" "}
                    <button className="btn" onClick={() => setDel(s)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {add && <SubAddModal onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(); }} />}
      {edit && <SubEditModal sub={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {del && (
        <ConfirmDelete
          title={`刪除訂閱 · ${del.user_name} · ${del.plan_name}`}
          message={`將一併刪除此訂閱的 ${del.payment_count ?? 0} 筆繳費紀錄。\n此操作無法復原。（若只想停收可改用「編輯 → 狀態 cancelled」）`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteSubscription(del.id); setDel(null); reload(); }}
        />
      )}
    </>
  );
}
function SubAddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const users = useAsync(() => api.users(), []);
  const plans = useAsync(() => api.plans(), []);
  const [f, set] = useForm({ user_id: "", plan_id: "", start_date: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.user_id || !f.plan_id || !f.start_date) { setErr("請填成員、方案、起算日"); return; }
    setBusy(true); setErr(null);
    try { await api.createSubscription({ user_id: Number(f.user_id), plan_id: Number(f.plan_id), start_date: f.start_date }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title="新增訂閱（會立即建立第一期 payment）" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="成員"><select value={f.user_id} onChange={(e) => set("user_id", e.target.value)} disabled={busy}><option value="">選擇…</option>{users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></Field>
      <Field label="方案"><select value={f.plan_id} onChange={(e) => set("plan_id", e.target.value)} disabled={busy}><option value="">選擇…</option>{plans.data?.plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}（NT${p.monthly_amount}）</option>)}</select></Field>
      <Field label="起算日 (YYYY-MM-DD)"><input value={f.start_date} onChange={(e) => set("start_date", e.target.value)} placeholder="2026-05-01" disabled={busy} /></Field>
      <button className="btn btn--primary" onClick={save} disabled={busy}>建立</button>
    </Modal>
  );
}
function SubEditModal({ sub, onClose, onDone }: { sub: Subscription; onClose: () => void; onDone: () => void }) {
  const [f, set] = useForm({ status: sub.status, start_date: sub.start_date, billing_day: String(sub.billing_day), custom_cycle: sub.custom_cycle });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { await api.updateSubscription(sub.id, { status: f.status, start_date: f.start_date, billing_day: Number(f.billing_day), custom_cycle: f.custom_cycle ? 1 : 0 }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`編輯訂閱 · ${sub.user_name} · ${sub.plan_name}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="狀態"><select value={f.status} onChange={(e) => set("status", e.target.value)} disabled={busy}><option value="active">active</option><option value="paused">paused</option><option value="cancelled">cancelled</option></select></Field>
      <Field label="起算日"><input value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
      <Field label="結帳日 (1-28)"><input type="number" value={f.billing_day} onChange={(e) => set("billing_day", e.target.value)} disabled={busy} /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input type="checkbox" checked={!!f.custom_cycle} onChange={(e) => set("custom_cycle", e.target.checked ? 1 : 0)} disabled={busy} /> 自訂週期（不對齊統一結帳日）
      </label>
      <button className="btn btn--primary" onClick={save} disabled={busy}>儲存</button>
    </Modal>
  );
}

// ── Plans ─────────────────────────────────────────────────────────────────────
export function Plans() {
  const { data, loading, error, reload } = useAsync(() => api.plans(), []);
  const [edit, setEdit] = useState<Plan | null | undefined>(undefined);
  const [del, setDel] = useState<Plan | null>(null);
  const [pFilter, setPFilter] = useState("");
  const providers = [...new Set((data?.plans ?? []).map((p) => p.provider).filter(Boolean))].sort();
  const shown = (data?.plans ?? []).filter((p) => !pFilter || p.provider === pFilter);
  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <Card title="方案" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增方案</button>}>
        {providers.length > 1 && (
          <div className="pills" style={{ padding: "12px 18px 0" }}>
            <button className={`pill ${pFilter === "" ? "pill--on" : ""}`} onClick={() => setPFilter("")}>全部</button>
            {providers.map((pv) => (
              <button key={pv} className={`pill ${pFilter === pv ? "pill--on" : ""}`} onClick={() => setPFilter(pv)}>{pv}</button>
            ))}
          </div>
        )}
        <div className="tbl">
          <table>
            <thead><tr><th>名稱</th><th>provider</th><th className="right">月費</th><th>身分組 ID</th><th>啟用</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {shown.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td><td>{p.provider}</td><td className="right mono">NT${p.monthly_amount}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{p.discord_role_id ?? "—"}</td><td>{p.active ? "✓" : "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(p)}>編輯</button>{" "}
                    <button className="btn" disabled={(p.subscription_count ?? 0) > 0} title={(p.subscription_count ?? 0) > 0 ? "使用中，請先刪除訂閱或停用" : ""} onClick={() => setDel(p)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <PlanModal plan={edit} providers={providers} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDelete
          title={`刪除方案 · ${del.name}`}
          message={`確定刪除此方案？此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deletePlan(del.id); setDel(null); reload(); }}
        />
      )}
    </>
  );
}
function PlanModal({ plan, providers, onClose, onDone }: { plan: Plan | null; providers: string[]; onClose: () => void; onDone: () => void }) {
  const [f, set] = useForm({ name: plan?.name ?? "", provider: plan?.provider ?? "", monthly_amount: String(plan?.monthly_amount ?? ""), discord_role_id: plan?.discord_role_id ?? "", active: plan?.active ?? 1 });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    const provider = f.provider.trim().toLowerCase();
    if (!f.name || !f.monthly_amount) { setErr("請填名稱與月費"); return; }
    if (!provider) { setErr("請填 provider"); return; }
    setBusy(true); setErr(null);
    try {
      const body: any = { name: f.name, provider, monthly_amount: Number(f.monthly_amount), discord_role_id: f.discord_role_id || undefined, active: f.active ? 1 : 0 };
      if (plan) await api.updatePlan(plan.id, body); else await api.createPlan(body);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={plan ? "編輯方案" : "新增方案"} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="名稱"><input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={busy} /></Field>
      <Field label="provider（選現有或直接輸入新的，如 gemini、glm）">
        <input list="plan-providers" value={f.provider} onChange={(e) => set("provider", e.target.value)} disabled={busy} placeholder="openai / anthropic / gemini …" />
        <datalist id="plan-providers">{providers.map((pv) => <option key={pv} value={pv} />)}</datalist>
      </Field>
      <Field label="月費 (TWD)"><input type="number" value={f.monthly_amount} onChange={(e) => set("monthly_amount", e.target.value)} disabled={busy} /></Field>
      <Field label="Discord 身分組 ID（通知 tag 用）"><input value={f.discord_role_id} onChange={(e) => set("discord_role_id", e.target.value)} disabled={busy} /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}><input type="checkbox" checked={!!f.active} onChange={(e) => set("active", e.target.checked ? 1 : 0)} disabled={busy} /> 啟用</label>
      <button className="btn btn--primary" onClick={save} disabled={busy}>儲存</button>
    </Modal>
  );
}

// ── Channel tags ──────────────────────────────────────────────────────────────
// type is a coarse category (umbrella); the channel itself is the `name`. New methods like
// iPass Money are new rows under an existing type, no schema change.
const CHANNEL_TYPES = [
  { v: "mobilepayment", label: "行動支付" },
  { v: "bank", label: "銀行轉帳" },
  { v: "other", label: "其他" },
];
const CHANNEL_TYPE_LABEL: Record<string, string> = Object.fromEntries(CHANNEL_TYPES.map((t) => [t.v, t.label]));

export function ChannelTags() {
  const { data, loading, error, reload } = useAsync(() => api.channelTags(), []);
  const [edit, setEdit] = useState<ChannelTag | null | undefined>(undefined);
  const [del, setDel] = useState<ChannelTag | null>(null);
  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <Card title="支付渠道（對帳分組）" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增渠道</button>}>
        <div className="tbl">
          <table>
            <thead><tr><th>名稱</th><th>類型</th><th className="right">排序</th><th>啟用</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><Empty>載入中…</Empty></td></tr>}
              {data?.channel_tags.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td><td>{t.type ? (CHANNEL_TYPE_LABEL[t.type] ?? t.type) : "—"}</td><td className="right mono">{t.sort_order}</td><td>{t.active ? "✓" : "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(t)}>編輯</button>{" "}
                    <button className="btn" disabled={(t.usage_count ?? 0) > 0} title={(t.usage_count ?? 0) > 0 ? "已被繳費紀錄參照，請改用停用" : ""} onClick={() => setDel(t)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <TagModal tag={edit} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDelete
          title={`刪除渠道 · ${del.name}`}
          message={`確定刪除此支付渠道？此操作無法復原。`}
          onClose={() => setDel(null)}
          onConfirm={async () => { await api.deleteChannelTag(del.id); setDel(null); reload(); }}
        />
      )}
    </>
  );
}
function TagModal({ tag, onClose, onDone }: { tag: ChannelTag | null; onClose: () => void; onDone: () => void }) {
  const [f, set] = useForm({ name: tag?.name ?? "", type: tag?.type ?? "other", sort_order: String(tag?.sort_order ?? 0), active: tag?.active ?? 1 });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.name) { setErr("請填名稱"); return; }
    setBusy(true); setErr(null);
    try {
      const body = { name: f.name, type: f.type, sort_order: Number(f.sort_order), active: f.active ? 1 : 0 };
      if (tag) await api.updateChannelTag(tag.id, body); else await api.createChannelTag(body);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={tag ? "編輯渠道" : "新增渠道"} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="名稱"><input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={busy} /></Field>
      <Field label="類型"><select value={f.type ?? "other"} onChange={(e) => set("type", e.target.value)} disabled={busy}>{CHANNEL_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select></Field>
      <Field label="排序"><input type="number" value={f.sort_order} onChange={(e) => set("sort_order", e.target.value)} disabled={busy} /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}><input type="checkbox" checked={!!f.active} onChange={(e) => set("active", e.target.checked ? 1 : 0)} disabled={busy} /> 啟用</label>
      <button className="btn btn--primary" onClick={save} disabled={busy}>儲存</button>
    </Modal>
  );
}
