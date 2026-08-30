import { useState } from "react";
import { api, nudgeSummary, type User, type Plan, type ChannelTag, type Subscription } from "../api";
import { useAsync, Card, Modal, Field, Empty, ConfirmDanger, ErrorNote, FilterSelect, TableFilter } from "../ui";

function useForm<T extends Record<string, any>>(initial: T) {
  const [v, setV] = useState<T>(initial);
  return [v, (k: keyof T, val: any) => setV((s) => ({ ...s, [k]: val }))] as const;
}

// ── Users ────────────────────────────────────────────────────────────────────
export function Users() {
  const { data, loading, error, reload } = useAsync(() => api.users(), []);
  const [edit, setEdit] = useState<User | null | undefined>(undefined); // undefined=closed, null=new
  const [del, setDel] = useState<User | null>(null);
  const [q, setQ] = useState("");
  // 未綁定的人收不到開繳／催繳的 @，而 onboarding 完全靠那個 @。原本這件事在後台看不出來 (C9)。
  const [onlyUnbound, setOnlyUnbound] = useState(false);
  const all = data?.users ?? [];
  const unboundCount = all.filter((u) => !u.discord_id).length;
  const needle = q.trim().toLowerCase();
  // The two filters compose: 未綁定 narrows the set, the search box narrows it further.
  const base = onlyUnbound ? all.filter((u) => !u.discord_id) : all;
  const shown = needle
    ? base.filter((u) => [u.display_name, u.email ?? "", u.discord_id ?? ""].some((x) => x.toLowerCase().includes(needle)))
    : base;
  return (
    <>
      {error && <ErrorNote message={error} onRetry={reload} />}
      <Card title="成員名單" action={
        <>
          <TableFilter value={q} onChange={setQ} placeholder="搜尋名稱／Email／Discord ID" shown={shown.length} total={all.length} />
          <button className="btn btn--primary" onClick={() => setEdit(null)}>新增成員</button>
        </>
      }>
        {unboundCount > 0 && (
          <div className="pills" style={{ padding: "12px 18px 0", alignItems: "center" }}>
            <button className={`pill ${onlyUnbound ? "" : "pill--on"}`} onClick={() => setOnlyUnbound(false)}>全部 {all.length} 人</button>
            <button className={`pill ${onlyUnbound ? "pill--on" : ""}`} onClick={() => setOnlyUnbound(true)}>未綁定 {unboundCount} 人</button>
            <span style={{ fontSize: 12.5, color: "var(--muted-strong)" }}>未綁定者收不到開繳／催繳的 @</span>
          </div>
        )}
        <div className="tbl tbl--pin-first tbl--pin-last">
          <table className="tbl-cards">
            <caption className="sr-only">成員名單</caption>
            <thead><tr><th scope="col">名稱</th><th scope="col">Discord ID</th><th scope="col">Email</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4}><Empty>載入中…</Empty></td></tr>}
              {!loading && shown.length === 0 && <tr><td colSpan={4}><Empty>{needle || onlyUnbound ? "沒有符合的成員" : "尚無成員"}</Empty></td></tr>}
              {shown.map((u) => (
                <tr key={u.id}>
                  <td data-label="名稱">{u.display_name}</td>
                  <td data-label="Discord ID" className="mono" style={{ fontSize: 12.5 }}>{u.discord_id ?? "—"}</td>
                  <td data-label="Email">{u.email ?? "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(u)}>編輯</button>{" "}
                    <button className="btn btn--danger" onClick={() => setDel(u)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <UserModal user={edit} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDanger
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
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  async function save() {
    if (!f.display_name) { setErr("請填名稱"); return; }
    setBusy(true); setErr(null);
    try {
      // discord_id: always send the (trimmed) value — an empty string explicitly unbinds (the backend
      // distinguishes "" = unbind from an omitted field = keep). email/note keep the omit-when-empty
      // behaviour (they COALESCE on the backend).
      const body = { display_name: f.display_name, discord_id: f.discord_id.trim(), email: f.email || undefined, note: f.note || undefined };
      if (user) await api.updateUser(user.id, body); else await api.createUser(body);
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function unbind() {
    if (!user) return;
    // Let the rejection propagate: ConfirmDanger owns busy/error for this action, so swallowing it
    // here would leave its confirm button stuck on 解除中… with the message hidden behind the modal.
    await api.updateUser(user.id, { discord_id: "" });
    onDone();
  }
  return (
    <Modal title={user ? "編輯成員" : "新增成員"} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <Field label="名稱"><input value={f.display_name} onChange={(e) => set("display_name", e.target.value)} disabled={busy} /></Field>
      <Field label="Discord ID"><input value={f.discord_id} onChange={(e) => set("discord_id", e.target.value)} disabled={busy} placeholder="清空並儲存即可解除綁定" /></Field>
      <Field label="Email"><input value={f.email} onChange={(e) => set("email", e.target.value)} disabled={busy} /></Field>
      <Field label="備註"><input value={f.note} onChange={(e) => set("note", e.target.value)} disabled={busy} /></Field>
      <div className="btn-row">
        <button className="btn btn--primary" onClick={save} disabled={busy}>儲存</button>
        {user?.discord_id && <button className="btn btn--danger" onClick={() => setConfirmUnbind(true)} disabled={busy}>解除綁定</button>}
      </div>
      {confirmUnbind && (
        <ConfirmDanger
          title="解除 Discord 綁定"
          message={`解除後這位成員的開繳／催繳通知都 @ 不到他，他也不能用 Discord 的「繳費」按鈕登記，直到重新綁定為止。\n他隨時可以自己用綁定按鈕或 /綁定 指令重新綁定。`}
          confirmLabel="確認解除綁定"
          busyLabel="解除中…"
          onClose={() => setConfirmUnbind(false)}
          onConfirm={unbind}
        />
      )}
    </Modal>
  );
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function Subscriptions() {
  const { data, loading, error, reload } = useAsync(() => api.subscriptions(), []);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Subscription | null>(null);
  const [del, setDel] = useState<Subscription | null>(null);
  const [q, setQ] = useState("");
  const all = data?.subscriptions ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((s) => [s.user_name, s.plan_name, s.status].some((x) => String(x).toLowerCase().includes(needle)))
    : all;
  return (
    <>
      {error && <ErrorNote message={error} onRetry={reload} />}
      <Card title="訂閱清單" action={
        <>
          <TableFilter value={q} onChange={setQ} placeholder="搜尋成員／方案" shown={shown.length} total={all.length} />
          <button className="btn btn--primary" onClick={() => setAdd(true)}>新增訂閱</button>
        </>
      }>
        <div className="tbl tbl--pin-first tbl--pin-last">
          <table className="tbl-cards">
            <caption className="sr-only">訂閱清單</caption>
            <thead><tr><th scope="col">成員</th><th scope="col">方案</th><th scope="col">狀態</th><th scope="col">起算日</th><th scope="col" className="right">結帳日</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {!loading && shown.length === 0 && <tr><td colSpan={6}><Empty>{needle ? "沒有符合的訂閱" : "尚無訂閱"}</Empty></td></tr>}
              {shown.map((s) => (
                <tr key={s.id}>
                  <td data-label="成員">{s.user_name}</td>
                  <td data-label="方案">{s.plan_name}</td>
                  <td data-label="狀態">{s.status}</td>
                  <td data-label="起算日" className="mono">{s.start_date}</td>
                  <td data-label="結帳日" className="right mono">{s.billing_day}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(s)}>編輯</button>{" "}
                    <button className="btn btn--danger" onClick={() => setDel(s)}>刪除</button>
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
        <ConfirmDanger
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
  const [notify, setNotify] = useState(true);
  const [nudged, setNudged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.user_id || !f.plan_id || !f.start_date) { setErr("請填成員、方案、起算日"); return; }
    setBusy(true); setErr(null);
    try {
      await api.createSubscription({ user_id: Number(f.user_id), plan_id: Number(f.plan_id), start_date: f.start_date });
      // 建立訂閱會立刻開出第一期帳單，但沒有任何人會告訴這位成員 (C1)。訂閱已經建立成功，
      // 所以通知沒送成不算失敗——顯示原因後停在原地，讓管理員知道發生什麼事再自行關閉。
      if (notify) {
        const r = await api.nudgeMembers({ period: f.start_date.slice(0, 7), user_ids: [Number(f.user_id)], kind: "added" });
        if (r.notified === 0) { setNudged(nudgeSummary(r)); setBusy(false); return; }
      }
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title="新增訂閱（會立即建立第一期 payment）" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <FilterSelect label="成員" value={f.user_id} disabled={busy}
        onChange={(v) => set("user_id", v)}
        options={(users.data?.users ?? []).map((u) => ({ value: String(u.id), label: u.display_name }))} />
      <FilterSelect label="方案" value={f.plan_id} disabled={busy}
        onChange={(v) => set("plan_id", v)}
        options={(plans.data?.plans ?? []).filter((p) => p.active).map((p) => ({ value: String(p.id), label: `${p.name}（NT$${p.monthly_amount}）` }))} />
      {/* type=date, not a bare text box with a placeholder: everywhere else in the app a date is
          picked (Settings and the payment modals all use type="month"). */}
      <Field label="起算日"><input type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={busy} /> 建立後在頻道 @ 通知這位成員繳費
      </label>
      {nudged && <div style={{ color: "var(--muted-strong)", fontSize: 13, marginBottom: 10 }}>{nudged}</div>}
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
      <Field label="起算日"><input type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={busy} /></Field>
      <Field label="結帳日 (1-28)">
        <span className="field__hint">每月幾號為這個訂閱結帳。29–31 在短月會落空，所以上限是 28。</span>
        <input type="number" min={1} max={28} value={f.billing_day} onChange={(e) => set("billing_day", e.target.value)} disabled={busy} />
      </Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <input type="checkbox" checked={!!f.custom_cycle} onChange={(e) => set("custom_cycle", e.target.checked ? 1 : 0)} disabled={busy} /> 自訂週期（不對齊統一結帳日）
      </label>
      <span className="field__hint" style={{ marginBottom: 14 }}>
        勾選後這個訂閱依自己的結帳日出帳，不跟著工作區的統一結帳日；排程只會在該日產生它的帳單。
      </span>
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
      {error && <ErrorNote message={error} onRetry={reload} />}
      <Card title="方案清單" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增方案</button>}>
        {providers.length > 1 && (
          <div className="pills" style={{ padding: "12px 18px 0" }}>
            <button className={`pill ${pFilter === "" ? "pill--on" : ""}`} onClick={() => setPFilter("")}>全部</button>
            {providers.map((pv) => (
              <button key={pv} className={`pill ${pFilter === pv ? "pill--on" : ""}`} onClick={() => setPFilter(pv)}>{pv}</button>
            ))}
          </div>
        )}
        <div className="tbl tbl--pin-first tbl--pin-last">
          <table className="tbl-cards">
            <caption className="sr-only">方案清單</caption>
            <thead><tr><th scope="col">名稱</th><th scope="col">provider</th><th scope="col" className="right">月費</th><th scope="col">身分組 ID</th><th scope="col">啟用</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><Empty>載入中…</Empty></td></tr>}
              {shown.map((p) => (
                <tr key={p.id}>
                  <td data-label="名稱">{p.name}</td>
                  <td data-label="provider">{p.provider}</td>
                  <td data-label="月費" className="right mono">NT${p.monthly_amount}</td>
                  <td data-label="身分組 ID" className="mono" style={{ fontSize: 12 }}>{p.discord_role_id ?? "—"}</td>
                  <td data-label="啟用">{p.active ? "✓" : "—"}</td>
                  <td className="right">
                    <button className="btn" onClick={() => setEdit(p)}>編輯</button>{" "}
                    <button className="btn btn--danger" disabled={(p.subscription_count ?? 0) > 0} title={(p.subscription_count ?? 0) > 0 ? "使用中，請先刪除訂閱或停用" : ""} onClick={() => setDel(p)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <PlanModal plan={edit} providers={providers} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDanger
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
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  // Toggle 停用/啟用 inline so disabling a channel is discoverable without opening the edit modal.
  // Sends only `active`; the worker COALESCEs the other columns, so name/type/sort_order are untouched.
  async function toggleActive(t: ChannelTag) {
    setBusyId(t.id); setActErr(null);
    try { await api.updateChannelTag(t.id, { active: t.active ? 0 : 1 }); reload(); }
    catch (e) { setActErr((e as Error).message); }
    finally { setBusyId(null); }
  }
  return (
    <>
      {(error || actErr) && <ErrorNote message={(error || actErr)!} onRetry={reload} />}
      <Card title="支付渠道（對帳分組）" action={<button className="btn btn--primary" onClick={() => setEdit(null)}>新增渠道</button>}>
        <div className="tbl tbl--pin-first tbl--pin-last">
          <table className="tbl-cards">
            <caption className="sr-only">支付渠道清單</caption>
            <thead><tr><th scope="col">名稱</th><th scope="col">類型</th><th scope="col" className="right">排序</th><th scope="col">狀態</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><Empty>載入中…</Empty></td></tr>}
              {data?.channel_tags.map((t) => (
                // Disabled channels dim the whole row so it's obvious at a glance which are off.
                <tr key={t.id} style={t.active ? undefined : { color: "var(--muted)" }}>
                  <td data-label="名稱">{t.name}</td>
                  <td data-label="類型">{t.type ? (CHANNEL_TYPE_LABEL[t.type] ?? t.type) : "—"}</td>
                  <td data-label="排序" className="right mono">{t.sort_order}</td>
                  <td data-label="狀態">
                    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, whiteSpace: "nowrap", ...(t.active ? { color: "var(--teal-ink)" } : { background: "#efe8da", color: "#8a7d63" }) }}>
                      {t.active ? "啟用中" : "已停用"}
                    </span>
                  </td>
                  <td className="right">
                    <button className="btn" disabled={busyId === t.id} onClick={() => toggleActive(t)}>{t.active ? "停用" : "啟用"}</button>{" "}
                    <button className="btn" onClick={() => setEdit(t)}>編輯</button>{" "}
                    <button className="btn btn--danger" disabled={(t.usage_count ?? 0) > 0} title={(t.usage_count ?? 0) > 0 ? "已被繳費紀錄參照，請改用停用" : ""} onClick={() => setDel(t)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && <TagModal tag={edit} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); reload(); }} />}
      {del && (
        <ConfirmDanger
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
