import { useEffect, useState } from "react";
import { api, currentPeriod, nextBillingPeriod } from "../api";
import { useAsync, Card, Field, Empty, Modal, IconCheck, IconWarning } from "../ui";

const PLACEHOLDER_RE = /\{(\w+)\}/g;
const OVERDUE_KEYS = ["period", "count", "list"];
const BILLING_KEYS = ["period", "plans", "total"];
const MSG_KEYS = ["period"];

function renderTpl(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (whole, key) => (key in vars ? vars[key]! : whole));
}
// Render a Discord-flavored markdown subset to HTML so the preview matches what Discord shows
// (the reported case: **bold** rendered literally before). Input is HTML-escaped first, so the
// returned string is safe to inject. Code is protected before emphasis so markdown inside
// `code`/```blocks``` stays literal, exactly like Discord — and the default templates use both
// **bold** and `/繳費`. Newlines are left to the container's white-space: pre-wrap.
function renderDiscordMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const emphasis = (s: string) => s
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([\s\S]+?)__/g, "<u>$1</u>")
    .replace(/~~([\s\S]+?)~~/g, "<s>$1</s>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+?)_/g, "<em>$1</em>");
  // Split into code / non-code segments and apply emphasis only outside code, so markdown inside
  // `code` or ```blocks``` stays literal — exactly how Discord renders it. Each segment is
  // HTML-escaped before any tags are added, so the result is safe to inject.
  const codeRe = /```[\s\S]*?```|`[^`\n]+?`/g;
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = codeRe.exec(src))) {
    out += emphasis(esc(src.slice(last, m.index)));
    const tok = m[0];
    out += tok.startsWith("```")
      ? `<code style="display:block;white-space:pre-wrap;font-family:'Spline Sans Mono',monospace;background:rgba(31,28,23,.06);border-radius:6px;padding:6px 8px;margin:2px 0">${esc(tok.slice(3, -3).replace(/^\n/, ""))}</code>`
      : `<code style="font-family:'Spline Sans Mono',monospace;background:rgba(31,28,23,.08);border-radius:4px;padding:1px 4px">${esc(tok.slice(1, -1))}</code>`;
    last = m.index + tok.length;
  }
  return out + emphasis(esc(src.slice(last)));
}
function unknownKeys(tpl: string, allowed: string[]): string[] {
  return [...tpl.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!).filter((k) => !allowed.includes(k));
}
function sampleVars(): { overdue: Record<string, string>; billing: Record<string, string>; message: Record<string, string> } {
  const period = currentPeriod();
  return {
    overdue: { period, count: "2", list: "・@小明 ChatGPT NT$315、Claude Premium NT$1,258（合計 NT$1,573）\n・@小華 Claude Standard NT$251（合計 NT$251）" },
    billing: { period, plans: "@ChatGPT　ChatGPT：NT$315\n@Claude Premium　Claude Premium：NT$1,258", total: "1,573" },
    message: { period },
  };
}

function TemplateField({ label, value, onChange, allowed, sample, disabled, rows }: {
  label: string; value: string; onChange: (v: string) => void; allowed: string[];
  sample: Record<string, string>; disabled: boolean; rows: number;
}) {
  const unknown = unknownKeys(value, allowed);
  return (
    <Field label={label}>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={rows} style={{ width: "100%", fontFamily: "inherit" }} />
      {unknown.length > 0 && (
        <div className="error-banner" style={{ marginTop: 6 }}>未知的佔位符：{unknown.map((k) => `{${k}}`).join(", ")}（請修正後才能儲存）</div>
      )}
      <div style={{ marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6, whiteSpace: "pre-wrap", fontSize: 13, color: "var(--muted)" }}>
        <div className="field__label" style={{ marginBottom: 4 }}>預覽</div>
        {/* Render the Discord markdown so the preview matches the sent message; HTML is escaped in renderDiscordMarkdown. */}
        <div dangerouslySetInnerHTML={{ __html: renderDiscordMarkdown(renderTpl(value, sample)) }} />
      </div>
    </Field>
  );
}

export function Settings() {
  const { data, loading, error } = useAsync(() => api.workspace(), []);
  const [billingDay, setBillingDay] = useState("5");
  const [overdue, setOverdue] = useState("3");
  const [retention, setRetention] = useState("24");
  const [guild, setGuild] = useState("");
  const [channel, setChannel] = useState("");
  const [adminIds, setAdminIds] = useState("");
  const [tplOverdue, setTplOverdue] = useState("");
  const [tplBilling, setTplBilling] = useState("");
  const [tplMessage, setTplMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const w = (data as any).workspace;
    setBillingDay(String(w.billing_day));
    setOverdue(String(w.settings.overdue_days));
    setRetention(String(w.settings.proof_retention_months));
    setGuild(w.settings.discord_guild_id ?? "");
    setChannel(w.settings.discord_billing_channel_id ?? "");
    setAdminIds((w.settings.admin_discord_ids ?? []).join(", "));
    setTplOverdue(w.settings.overdue_template ?? "");
    setTplBilling(w.settings.billing_opened_template ?? "");
    setTplMessage(w.settings.payment_message_template ?? "");
  }, [data]);

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api.updateWorkspace({
        billing_day: Number(billingDay),
        settings: {
          overdue_days: Number(overdue),
          proof_retention_months: Number(retention),
          discord_guild_id: guild,
          discord_billing_channel_id: channel,
          admin_discord_ids: adminIds.split(",").map((s) => s.trim()).filter(Boolean),
          overdue_template: tplOverdue,
          billing_opened_template: tplBilling,
          payment_message_template: tplMessage,
        },
      });
      setSaved(true);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (error) return <div className="error-banner">{error}</div>;

  const samples = sampleVars();
  // Use the form's billing-day value so the 發起繳費 default tracks edits (and saves) immediately.
  const effBillingDay = Number(billingDay) || 1;
  const tplInvalid =
    unknownKeys(tplOverdue, OVERDUE_KEYS).length > 0 ||
    unknownKeys(tplBilling, BILLING_KEYS).length > 0 ||
    unknownKeys(tplMessage, MSG_KEYS).length > 0;

  return (
    <Card title="設定">
      <div style={{ padding: "18px 20px", maxWidth: 460 }}>
        {err && <div className="error-banner">{err}</div>}
        {saved && <div style={{ color: "var(--teal)", marginBottom: 12 }}>✓ 已儲存</div>}
        {data && (
          <div style={{ marginBottom: 14, fontSize: 14 }}>
            <span className="field__label">截圖儲存（R2）：</span>{" "}
            {(data as any).r2_configured
              ? <span style={{ color: "var(--teal)" }}><IconCheck /> 已啟用</span>
              : <span style={{ color: "var(--muted)" }}><IconWarning /> 未啟用（成員無法上傳截圖；其餘功能正常）</span>}
          </div>
        )}
        <Field label="統一結帳日 (1-28)"><input type="number" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} disabled={busy} /></Field>
        <Field label="逾期天數"><input type="number" value={overdue} onChange={(e) => setOverdue(e.target.value)} disabled={busy} /></Field>
        <Field label="截圖保存月數 (retention)"><input type="number" value={retention} onChange={(e) => setRetention(e.target.value)} disabled={busy} /></Field>
        <Field label="Discord Guild ID"><input value={guild} onChange={(e) => setGuild(e.target.value)} disabled={busy} /></Field>
        <Field label="Discord 繳費頻道 ID"><input value={channel} onChange={(e) => setChannel(e.target.value)} disabled={busy} /></Field>
        <Field label="可發起繳費的管理員 Discord ID（逗號分隔）"><input value={adminIds} onChange={(e) => setAdminIds(e.target.value)} disabled={busy} /></Field>
        <TemplateField label="逾期催繳文字（{period} {count} {list}）" value={tplOverdue} onChange={setTplOverdue} allowed={OVERDUE_KEYS} sample={samples.overdue} disabled={busy} rows={4} />
        <TemplateField label="開繳通知文字（{period} {plans} {total}）" value={tplBilling} onChange={setTplBilling} allowed={BILLING_KEYS} sample={samples.billing} disabled={busy} rows={4} />
        <TemplateField label="常駐繳費訊息文字（{period}）" value={tplMessage} onChange={setTplMessage} allowed={MSG_KEYS} sample={samples.message} disabled={busy} rows={3} />
        {tplInvalid && <div className="error-banner" style={{ marginBottom: 10 }}>有未知的佔位符，請修正後再儲存。</div>}
        <button className="btn btn--primary" onClick={save} disabled={busy || tplInvalid}>儲存設定</button>

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">常駐繳費訊息</div>
        <RebuildMessage />

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <div className="field__label">Discord slash 指令</div>
        <RegisterCommands />

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
        <InitiateBilling billingDay={effBillingDay} />

        <ImportRoster />
      </div>
    </Card>
  );
}

function ImportRoster() {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (!file) { setErr("請選擇 CSV 檔"); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.importMembers(file, start || undefined);
      const s = r.summary;
      setMsg(`✓ 建立 ${s.usersCreated} 人 / 更新 ${s.usersUpdated} 人 / 新增 ${s.subsCreated} 訂閱 / 跳過 ${s.subsSkipped} 訂閱 / 略過 ${s.rowsSkipped} 列` +
        (s.unmatchedPlans.length ? ` · 對不到的方案：${s.unmatchedPlans.join(", ")}` : ""));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "22px 0 18px" }} />
      <div className="field__label">匯入名單（CSV）</div>
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 10px" }}>欄位需為「姓名, 帳號, 方案名…」；方案名須與系統方案一致。空白＝起算當月。</p>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
      <div style={{ marginTop: 10 }}>
        <Field label="起算月份第一天（選填，YYYY-MM-DD）"><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01" disabled={busy} /></Field>
      </div>
      <button className="btn btn--primary" onClick={run} disabled={busy}>匯入</button>
    </>
  );
}

function InitiateBilling({ billingDay }: { billingDay: number }) {
  const plans = useAsync(() => api.plans(), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="field__label">發起繳費</div>
      <button className="btn" onClick={() => setOpen(true)}>確認本期金額並發出開繳通知</button>
      {open && plans.data && <InitiateModal plans={plans.data.plans.filter((p) => p.active)} billingDay={billingDay} onClose={() => setOpen(false)} />}
    </>
  );
}

function InitiateModal({ plans, billingDay, onClose }: { plans: { id: number; name: string; monthly_amount: number }[]; billingDay: number; onClose: () => void }) {
  const [period, setPeriod] = useState(nextBillingPeriod(billingDay));
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(plans.map((p) => [p.id, String(p.monthly_amount)])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.initiateBilling({
        period,
        amounts: plans.map((p) => ({ plan_id: p.id, amount: Number(amounts[p.id]) })),
      });
      setMsg(r.sent ? `✓ 已發出通知（更新 ${r.updated_plans} 方案 / ${r.updated_payments} 筆）` : `✓ 已更新金額（通知先前已發送）`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <Modal title="發起繳費" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>修改金額即為該方案的新定價（下期沿用）；已繳／已驗證的紀錄不受影響。</p>
      <Field label="期別"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} /></Field>
      {plans.map((p) => (
        <Field key={p.id} label={`${p.name} 金額`}>
          <input type="number" value={amounts[p.id] ?? ""} onChange={(e) => setAmounts((s) => ({ ...s, [p.id]: e.target.value }))} disabled={busy} />
        </Field>
      ))}
      <button className="btn btn--primary" onClick={run} disabled={busy}>發起並通知</button>
    </Modal>
  );
}

function RebuildMessage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.rebuildPaymentMessage(); setMsg(`✓ 已建立/更新（訊息 id ${r.message_id}）`); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <button className="btn" onClick={run} disabled={busy}>於 #繳費頻道 建立/重建「繳費」按鈕訊息</button>
    </>
  );
}

function RegisterCommands() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.registerCommands(); setMsg(`✓ 已註冊 ${r.registered} 個 slash 指令`); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div style={{ color: "var(--teal)", marginBottom: 10 }}>{msg}</div>}
      <button className="btn" onClick={run} disabled={busy}>註冊 / 更新 Discord slash 指令（/繳費、/發起繳費、/綁定）</button>
    </>
  );
}
