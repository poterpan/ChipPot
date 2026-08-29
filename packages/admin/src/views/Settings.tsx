import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, currentPeriod, periodForBillingDay, nextBillingPeriod, NOTIFY_REASON_TEXT, type ImportDiff, type ImportSubLine, type InitiatePreview, type InitiateApplied } from "../api";
import { useAsync, Card, Field, Empty, Modal, Stat, IconCheck, IconWarning } from "../ui";
import { DiffList } from "../components/DiffList";

const PLACEHOLDER_RE = /\{(\w+)\}/g;
const OVERDUE_KEYS = ["period", "count", "list"];
const BILLING_KEYS = ["period", "plans", "total"];
const MSG_KEYS = ["period"];
const NOTIFY_KEYS = ["payer", "amount", "period", "admin_url"];
// Mirrors DEFAULT_NOTIFY_TEMPLATE in worker/src/core/payment-notify.ts.
const DEFAULT_NOTIFY = "💳 新繳費待審核：{payer} NT${amount}（{period}）";

// Settings timestamps are stored as UTC ISO (worker core/time.ts nowUtcIso). The rest of the app
// reasons in Taipei time, so slicing the ISO string would date anything done before 08:00 Taipei to
// the previous day. Falls back to the raw first 10 chars if the stored value is not a date.
function taipeiDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function renderTpl(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (whole, key) => (key in vars ? vars[key]! : whole));
}
// Render a Discord-flavored markdown subset to HTML so the preview matches what Discord shows.
// Input is HTML-escaped first, so the returned string is safe to inject; code is protected before
// emphasis so markdown inside `code`/```blocks``` stays literal, exactly like Discord.
function renderDiscordMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const emphasis = (s: string) => s
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([\s\S]+?)__/g, "<u>$1</u>")
    .replace(/~~([\s\S]+?)~~/g, "<s>$1</s>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+?)_/g, "<em>$1</em>");
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
        <div className="field__label" style={{ marginBottom: 4, color: "var(--muted)", fontWeight: 400 }}>預覽</div>
        <div dangerouslySetInnerHTML={{ __html: renderDiscordMarkdown(renderTpl(value, sample)) }} />
      </div>
    </Field>
  );
}

interface Form {
  billing_day: string; overdue_days: string; proof_retention_months: string;
  discord_guild_id: string; discord_billing_channel_id: string; admin_discord_ids: string;
  bark_key: string; bark_server: string; webhook_url: string; notify_template: string;
  overdue_template: string; billing_opened_template: string; payment_message_template: string;
  /** '1' = on, '' = off — the Form is all strings so `dirty` stays a plain JSON compare. */
  receipt_notify_verified: string;
}
const EMPTY: Form = {
  billing_day: "", overdue_days: "", proof_retention_months: "",
  discord_guild_id: "", discord_billing_channel_id: "", admin_discord_ids: "",
  bark_key: "", bark_server: "https://api.day.app", webhook_url: "", notify_template: "",
  overdue_template: "", billing_opened_template: "", payment_message_template: "",
  receipt_notify_verified: "",
};

export function Settings() {
  const { data, loading, error } = useAsync(() => api.workspace(), []);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // What the three 立即執行 rows show once one of them runs. api.workspace() is deliberately NOT
  // re-fetched afterwards — the effect below would overwrite the admin's unsaved edits with the
  // server copy — so each action hands its new value back here instead of leaving a stale row.
  const [live, setLive] = useState<{ pay?: string; bind?: string; cmd?: string }>({});

  useEffect(() => {
    if (!data) return;
    const w = (data as any).workspace; const s = w.settings;
    const f: Form = {
      billing_day: String(w.billing_day),
      overdue_days: String(s.overdue_days),
      proof_retention_months: String(s.proof_retention_months),
      discord_guild_id: s.discord_guild_id ?? "",
      discord_billing_channel_id: s.discord_billing_channel_id ?? "",
      admin_discord_ids: (s.admin_discord_ids ?? []).join(", "),
      bark_key: s.payment_bark_key ?? "",
      bark_server: s.payment_bark_server ?? "https://api.day.app",
      webhook_url: s.payment_webhook_url ?? "",
      notify_template: s.payment_notify_template ?? "",
      overdue_template: s.overdue_template ?? "",
      billing_opened_template: s.billing_opened_template ?? "",
      payment_message_template: s.payment_message_template ?? "",
      receipt_notify_verified: s.receipt_notify_verified ? "1" : "",
    };
    setForm(f); setSaved(f);
  }, [data]);

  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const samples = sampleVars();
  const tplInvalid =
    unknownKeys(form.overdue_template, OVERDUE_KEYS).length > 0 ||
    unknownKeys(form.billing_opened_template, BILLING_KEYS).length > 0 ||
    unknownKeys(form.payment_message_template, MSG_KEYS).length > 0 ||
    unknownKeys(form.notify_template, NOTIFY_KEYS).length > 0;
  // One-off actions use the SAVED billing day (not the unsaved form value), so the period they
  // act on always matches what's persisted. Edits only take effect after 儲存變更.
  const savedBillingDay = Number(saved.billing_day) || 1;

  function flash(msg: string) { setToast(msg); window.setTimeout(() => setToast(null), 2400); }
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.updateWorkspace({
        billing_day: Number(form.billing_day),
        settings: {
          overdue_days: Number(form.overdue_days),
          proof_retention_months: Number(form.proof_retention_months),
          discord_guild_id: form.discord_guild_id,
          discord_billing_channel_id: form.discord_billing_channel_id,
          admin_discord_ids: form.admin_discord_ids.split(",").map((s) => s.trim()).filter(Boolean),
          overdue_template: form.overdue_template,
          billing_opened_template: form.billing_opened_template,
          payment_message_template: form.payment_message_template,
          payment_bark_key: form.bark_key.trim(),
          payment_bark_server: form.bark_server.trim() || "https://api.day.app",
          payment_webhook_url: form.webhook_url.trim(),
          payment_notify_template: form.notify_template.trim(),
          receipt_notify_verified: form.receipt_notify_verified === "1",
        },
      });
      setSaved(form); flash("已儲存變更");
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (error) return <div className="error-banner">{error}</div>;

  const r2 = (data as any)?.r2_configured;
  // 立即執行 rows say what is currently persisted, so "重建" reads as "this exists, redo it" rather
  // than as an action with no visible before/after. 發起繳費 and 匯入名單 CSV get no such line:
  // whether a period is open belongs to 繳費審核, and repeating it here is one more thing to go stale.
  const s0 = (data as any)?.workspace?.settings ?? {};
  const posted = (id: string) => (id ? <>目前：<b>已張貼</b>（訊息 id <span className="mono">{id}</span>）</> : <>目前：<b>尚未張貼</b></>);
  const payMsgState = posted(live.pay ?? s0.discord_payment_message_id ?? "");
  const bindMsgState = posted(live.bind ?? s0.discord_bind_message_id ?? "");
  const cmdAt = String(live.cmd ?? s0.discord_commands_registered_at ?? "");
  const cmdState = cmdAt
    ? <>目前：<b>已註冊</b>（{taipeiDay(cmdAt)}）</>
    : <>目前：<b>尚未註冊</b></>;
  const notifyTpl = form.notify_template.trim() || DEFAULT_NOTIFY;
  const notifySample = { payer: "廖清筆", amount: "1,258", period: currentPeriod(), admin_url: `${window.location.origin}/#payments?user=42&period=${currentPeriod()}` };
  const notifyPreview = renderTpl(notifyTpl, notifySample) + (/\{admin_url\}/.test(notifyTpl) ? "" : `\n審核 → ${notifySample.admin_url}`);

  return (
    <div className="settings">
      {err && <div className="error-banner">{err}</div>}

      <Card title="基本計費" desc="收費節奏與截圖保存"
        action={r2 != null && (r2
          ? <span className="chip chip--ok"><IconCheck /> 截圖儲存已啟用</span>
          : <span className="chip chip--off"><IconWarning /> 截圖未啟用</span>)}>
        <div className="card__body">
          <div className="grid2">
            <Field label="每月結帳日"><span className="field__hint">每月幾號向所有成員開帳收費（1–28）。</span><input type="number" min={1} max={28} value={form.billing_day} onChange={(e) => set("billing_day")(e.target.value)} disabled={busy} /></Field>
            <Field label="逾期天數"><span className="field__hint">開帳後幾天仍未繳就列入催繳。</span><input type="number" min={0} value={form.overdue_days} onChange={(e) => set("overdue_days")(e.target.value)} disabled={busy} /></Field>
            <Field label="截圖保存月數"><span className="field__hint">超過月數的繳費截圖自動清除（對帳資料保留）。</span><input type="number" min={1} value={form.proof_retention_months} onChange={(e) => set("proof_retention_months")(e.target.value)} disabled={busy} /></Field>
          </div>
        </div>
      </Card>

      <Card title="審核結果通知" desc="成員送出繳費後，審核結果要不要回到 Discord 頻道給他">
        <div className="card__body">
          <Field label="確認時也通知成員">
            <span className="field__hint">
              <b>退回一定會通知</b>（附退回原因），這是成員唯一知道要重繳的管道，不能關閉。
              確認則預設不通知 —— 每張帳單都貼一則，頻道很快就洗版。打開後，一位成員同期多筆會合併成一則。
            </span>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: busy ? "default" : "pointer" }}>
              <input
                type="checkbox"
                checked={form.receipt_notify_verified === "1"}
                onChange={(e) => set("receipt_notify_verified")(e.target.checked ? "1" : "")}
                disabled={busy}
              />
              <span>確認繳費時，在頻道 @ 該成員告知已確認</span>
            </label>
          </Field>
        </div>
      </Card>

      <Card title="Discord 串接" desc="ID 在 Discord 開「開發者模式」後右鍵複製">
        <div className="card__body">
          <div className="grid2">
            <Field label="伺服器 ID（Guild）"><span className="field__hint">右鍵你的伺服器 → 複製伺服器 ID。</span><input className="mono" value={form.discord_guild_id} onChange={(e) => set("discord_guild_id")(e.target.value)} disabled={busy} /></Field>
            <Field label="繳費頻道 ID"><span className="field__hint">右鍵繳費頻道 → 複製頻道 ID。</span><input className="mono" value={form.discord_billing_channel_id} onChange={(e) => set("discord_billing_channel_id")(e.target.value)} disabled={busy} /></Field>
          </div>
          <Field label="可發起繳費的管理員"><span className="field__hint">能在 Discord 用 <code className="ph">/發起繳費</code> 的人（逗號分隔的 Discord ID）。與「能登入這個後台」是兩回事 —— 後台登入由 Cloudflare Access 控管。</span><input className="mono" value={form.admin_discord_ids} onChange={(e) => set("admin_discord_ids")(e.target.value)} disabled={busy} /></Field>
        </div>
      </Card>

      <Card title="繳費通知" desc="有人送出繳費時通知你，並附一鍵直達的審核連結（選填）">
        <div className="card__body">
          <div className="field">
            <span className="field__label">Bark（手機推播）</span>
            <span className="field__hint">貼上 Bark App 的裝置金鑰即可，不必自己組網址。</span>
            <div className="notify-row">
              <input value={form.bark_key} onChange={(e) => set("bark_key")(e.target.value)} disabled={busy} placeholder="例如 3hGxx6xNqpHE7h5keQZNni" />
              <TestButton kind="bark" form={form} />
            </div>
          </div>
          <details className="adv" open={!!form.bark_server && form.bark_server !== "https://api.day.app"}>
            <summary>自架 Bark 伺服器</summary>
            <Field label="Bark 伺服器網址"><input value={form.bark_server} onChange={(e) => set("bark_server")(e.target.value)} disabled={busy} placeholder="https://api.day.app" /></Field>
          </details>
          <div className="field">
            <span className="field__label">Webhook</span>
            <span className="field__hint">貼上 Discord／Google Chat／Slack 的 Webhook 網址，格式自動判斷。</span>
            <div className="notify-row">
              <input value={form.webhook_url} onChange={(e) => set("webhook_url")(e.target.value)} disabled={busy} placeholder="https://discord.com/api/webhooks/..." />
              <TestButton kind="webhook" form={form} />
            </div>
          </div>

          <div className="preview-label">會送出的內容</div>
          <div className="preview">{notifyPreview}</div>

          <details className="custom" open={!!form.notify_template}>
            <summary>自訂通知文字</summary>
            <div className="field">
              <span className="field__hint">可用 <code className="ph">{"{payer}"}</code> <code className="ph">{"{amount}"}</code> <code className="ph">{"{period}"}</code> <code className="ph">{"{admin_url}"}</code>。留空＝用預設。</span>
              <textarea value={form.notify_template} onChange={(e) => set("notify_template")(e.target.value)} disabled={busy} rows={3} placeholder={DEFAULT_NOTIFY} style={{ width: "100%", fontFamily: "inherit" }} />
              {unknownKeys(form.notify_template, NOTIFY_KEYS).length > 0 && (
                <div className="error-banner" style={{ marginTop: 6 }}>未知的佔位符：{unknownKeys(form.notify_template, NOTIFY_KEYS).map((k) => `{${k}}`).join(", ")}</div>
              )}
            </div>
          </details>
        </div>
      </Card>

      <Card title="Discord 訊息文字" desc="機器人在頻道發出的訊息（支援 Discord markdown，即時預覽）">
        <div className="card__body">
          <TemplateField label="開繳通知（{period} {plans} {total}）" value={form.billing_opened_template} onChange={set("billing_opened_template")} allowed={BILLING_KEYS} sample={samples.billing} disabled={busy} rows={4} />
          <TemplateField label="逾期催繳（{period} {count} {list}）" value={form.overdue_template} onChange={set("overdue_template")} allowed={OVERDUE_KEYS} sample={samples.overdue} disabled={busy} rows={4} />
          <TemplateField label="常駐繳費訊息（{period}）" value={form.payment_message_template} onChange={set("payment_message_template")} allowed={MSG_KEYS} sample={samples.message} disabled={busy} rows={3} />
        </div>
      </Card>

      <Card title="工具" desc="點下去立即執行，不受上面的「儲存」控制">
        <div className="card__body">
          <ActionRow title="重建常駐繳費訊息" tag="立即執行" desc="在繳費頻道重新貼一則含「繳費」按鈕的常駐訊息。" state={payMsgState}><RebuildMessage onDone={(id) => setLive((s) => ({ ...s, pay: id }))} /></ActionRow>
          <ActionRow title="張貼／更新綁定按鈕訊息" tag="立即執行" desc="在帳單頻道貼一則含「綁定 Discord」按鈕的公開訊息，讓成員主動綁定（開繳／催繳才能 @ 到他）。" state={bindMsgState}><RebuildBindMessage onDone={(id) => setLive((s) => ({ ...s, bind: id }))} /></ActionRow>
          <ActionRow title="註冊 Discord 指令" tag="立即執行" desc="更新 /繳費、/發起繳費、/綁定 指令到你的伺服器。" state={cmdState}><RegisterCommands onDone={(at) => setLive((s) => ({ ...s, cmd: at }))} /></ActionRow>
          <ActionRow title="發起繳費" tag="會改價＋發通知" warn desc="確認指定期別的各方案金額，建立該期帳單並向所有成員發出開繳通知。送出前會先看影響預覽。"><InitiateBilling billingDay={savedBillingDay} dirty={dirty} /></ActionRow>
          <ActionRow title="匯入名單 CSV" tag="會新增/暫停訂閱" warn desc="用 CSV 批次建立或更新成員與訂閱；FALSE 的方案會暫停該訂閱。套用前先看差異預覽。"><ImportRoster /></ActionRow>
        </div>
      </Card>

      {dirty && (
        <div className="savebar">
          <span className="savebar__note"><span className="savebar__dot" />有尚未儲存的變更{tplInvalid && <span style={{ color: "var(--red)" }}>　·　有未知佔位符，請先修正</span>}</span>
          <button className="btn" onClick={() => setForm(saved)} disabled={busy}>捨棄</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || tplInvalid}>儲存變更</button>
        </div>
      )}
      {toast && <div style={{ position: "fixed", left: "50%", bottom: 84, transform: "translateX(-50%)", background: "var(--ink)", color: "#fff", padding: "10px 16px", borderRadius: 10, fontSize: 13.5, zIndex: 40 }}>{toast}</div>}
    </div>
  );
}

function ActionRow({ title, tag, desc, warn, state, children }: { title: string; tag: string; desc: string; warn?: boolean; state?: ReactNode; children: ReactNode }) {
  return (
    <div className={`actionrow${warn ? " actionrow--warn" : ""}`}>
      <div className="actionrow__main">
        <div className="actionrow__title">{title} <span className={`tag${warn ? " tag--warn" : ""}`}>{tag}</span></div>
        <div className="actionrow__desc">{desc}</div>
        {state != null && <div className="actionrow__desc" style={{ marginTop: 4 }}>{state}</div>}
      </div>
      <div className="actionrow__act">{children}</div>
    </div>
  );
}

// Fires a real test notification using the CURRENT (possibly unsaved) field values, so the owner
// can verify a Bark key / webhook before saving.
function TestButton({ kind, form }: { kind: "bark" | "webhook"; form: Form }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  async function run() {
    setBusy(true); setRes(null);
    try {
      const r = await api.testNotification({
        kind,
        bark_key: form.bark_key.trim(),
        bark_server: form.bark_server.trim(),
        webhook_url: form.webhook_url.trim(),
        template: form.notify_template.trim(),
      });
      setRes(r.ok ? { ok: true, msg: "✓ 已送出，去看看收到沒" } : { ok: false, msg: r.error ?? `送出失敗（${r.status ?? "?"}）` });
    } catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
    setBusy(false);
  }
  return (
    <>
      <button type="button" className="btn btn--sm" onClick={run} disabled={busy}>{busy ? "送出中…" : "送出測試"}</button>
      {res && <span className="act-feedback" style={{ color: res.ok ? "var(--teal)" : "var(--red)" }} title={res.msg}>{res.msg}</span>}
    </>
  );
}

function ImportRoster() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn--sm" onClick={() => setOpen(true)}>匯入…</button>
      {open && <ImportModal onClose={() => setOpen(false)} />}
    </>
  );
}

const subLine = (l: ImportSubLine) => `${l.user_name || l.email}·${l.plan_name} NT$${l.amount.toLocaleString()}`;
const BILL_STATUS: Record<string, string> = { pending: "待繳", rejected: "已退回" };

function ImportModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function preview() {
    if (!file) { setErr("請選擇 CSV 檔"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.importMembers(file, { startDate: start || undefined, dryRun: true });
      setDiff(r.diff);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  async function apply() {
    if (!file || busy) return; // belt: the button is also disabled while in flight
    setBusy(true); setErr(null);
    try {
      const r = await api.importMembers(file, { startDate: start || undefined, dryRun: false });
      const d = r.diff;
      setDiff(d);
      setDone(`✓ 已套用：新增 ${d.users_created.length} 人 / 新增 ${d.subs_added.length} 訂閱 / 恢復 ${d.subs_reactivated.length} / 暫停 ${d.subs_paused.length}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  const changes = diff
    ? diff.users_created.length + diff.subs_added.length + diff.subs_reactivated.length + diff.subs_paused.length
    : 0;

  return (
    <Modal title="匯入名單 CSV" onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}

      {!diff && (
        <>
          <p style={{ color: "var(--muted-strong)", fontSize: 13, margin: "0 0 12px" }}>
            欄位需為「姓名, 帳號, 方案名…」；方案名須與系統方案一致。方案格 <b>TRUE</b>＝訂閱、<b>FALSE</b>＝暫停該訂閱、<b>留空</b>＝不變動。起算月份留空＝當月。
          </p>
          <Field label="CSV 檔"><input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} /></Field>
          <Field label="起算月份第一天（選填，YYYY-MM-DD）"><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01" disabled={busy} /></Field>
          <button className="btn btn--primary" onClick={preview} disabled={busy}>{busy ? "計算差異中…" : "預覽差異"}</button>
        </>
      )}

      {diff && (
        <>
          {done && <div style={{ color: "var(--teal)", padding: "8px 0" }}>{done}</div>}
          <div className="stats">
            <Stat label="新成員" value={diff.users_created.length} />
            <Stat label="新增訂閱" value={diff.subs_added.length} />
            <Stat label="恢復訂閱" value={diff.subs_reactivated.length} />
            <Stat label="暫停訂閱" value={diff.subs_paused.length} />
          </div>

          {diff.users_created.length > 0 && <DiffList title="新成員" rows={diff.users_created.map((u) => `${u.user_name || "（未填姓名）"}·${u.email}`)} />}
          {diff.subs_added.length > 0 && <DiffList title="新增訂閱" rows={diff.subs_added.map(subLine)} />}
          {diff.subs_reactivated.length > 0 && <DiffList title="恢復訂閱（暫停→啟用）" rows={diff.subs_reactivated.map(subLine)} />}
          {diff.subs_paused.length > 0 && <DiffList title="暫停訂閱（CSV 為 FALSE）" rows={diff.subs_paused.map(subLine)} />}
          {diff.cancelled_conflicts.length > 0 && (
            <>
              <div className="warnnote">下列訂閱已被<b>取消</b>（不是暫停），匯入不會自動恢復；如要恢復請到「成員／訂閱」手動改狀態。</div>
              <DiffList title="需人工處理（已取消）" rows={diff.cancelled_conflicts.map(subLine)} />
            </>
          )}
          {diff.affected_pending_bills.length > 0 && (
            <>
              <div className="warnnote">
                被暫停的訂閱在 {diff.period} 還有 {diff.affected_pending_bills.length} 筆未繳帳單。匯入<b>不會</b>變更任何帳單；請到「繳費審核」按<b>重新同步本期帳單</b>清理。
              </div>
              <DiffList
                title={`${diff.period} 未繳帳單（匯入不會變更）`}
                rows={diff.affected_pending_bills.map((b) => `${b.user_name}·${b.plan_name} NT$${b.amount.toLocaleString()}（${BILL_STATUS[b.status] ?? b.status}）`)}
              />
            </>
          )}

          <p style={{ color: "var(--muted)", fontSize: 13, margin: "10px 0" }}>
            同步姓名 {diff.users_updated} 人 · 已訂閱跳過 {diff.subs_skipped} · 略過 {diff.rows_skipped} 列
            {diff.unmatched_plans.length > 0 && ` · 對不到的方案：${diff.unmatched_plans.join(", ")}`}
          </p>

          {!done && (
            <>
              {changes === 0 && <p style={{ color: "var(--muted)" }}>沒有新增／暫停／恢復；套用只會同步 {diff.users_updated} 位成員的姓名。</p>}
              <button className="btn btn--primary" onClick={apply} disabled={busy}>{busy ? "套用中…" : "確認套用"}</button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function InitiateBilling({ billingDay, dirty }: { billingDay: number; dirty: boolean }) {
  const plans = useAsync(() => api.plans(), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn--sm btn--danger" onClick={() => setOpen(true)}>發起繳費…</button>
      {open && plans.data && <InitiateModal plans={plans.data.plans.filter((p) => p.active)} billingDay={billingDay} dirty={dirty} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 發起繳費 — the heaviest write in the app (new prices, new bills, a rewrite of this period's
 * pending amounts, and a public broadcast). Two steps like SyncModal / RetractModal: preview what it
 * would change, then a red confirm whose label says whether a notice goes out.
 *
 * The period defaults to the one currently being collected (periodForBillingDay), the same default
 * the dashboard and the payments list use. Pre-opening the NEXT period is an explicit opt-in — with
 * billing_day = 1 the old nextBillingPeriod default silently pointed at next month for 29 days a
 * month, so "fix July's amount" pre-opened August and broadcast it.
 */
function InitiateModal({ plans, billingDay, dirty, onClose }: { plans: { id: number; name: string; monthly_amount: number }[]; billingDay: number; dirty: boolean; onClose: () => void }) {
  const current = periodForBillingDay(billingDay);
  const upcoming = nextBillingPeriod(billingDay);
  const next = upcoming === current ? null : upcoming;
  const [period, setPeriod] = useState(current);
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(plans.map((p) => [p.id, String(p.monthly_amount)])));
  const [preview, setPreview] = useState<InitiatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const payload = () => ({ period, amounts: plans.map((p) => ({ plan_id: p.id, amount: Number(amounts[p.id]) })) });
  const invalid = plans.some((p) => !/^\d+$/.test((amounts[p.id] ?? "").trim()));

  async function runPreview() {
    setBusy(true); setErr(null);
    try { setPreview(await api.initiateBilling({ ...payload(), dry_run: true }) as InitiatePreview); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.initiateBilling({ ...payload(), dry_run: false }) as InitiateApplied;
      setMsg(
        `${r.sent || r.notify_reason !== "send_failed" ? "✓" : "⚠️"} 已發起 ${period}：新增 ${r.created_payments} 筆帳單、改價 ${r.updated_payments} 筆、更新 ${r.updated_plans} 個方案定價。` +
        // The reason comes from THIS apply, not from the preview: the preview only predicted, and a
        // send can still be refused after it. send_failed adds where the period stands and the
        // way out, because that outcome — unlike the others — leaves an opened period behind.
        (r.sent
          ? "已在頻道發出開繳通知。"
          : `未發送通知：${NOTIFY_REASON_TEXT[r.notify_reason] ?? "通知未送出"}。` +
            (r.notify_reason === "send_failed"
              ? "本期已開繳、帳單已建立，可到「儀表板 → 推播狀態 → 重發開繳通知」補送。"
              : ""))
      );
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal title={`發起繳費 · ${period}`} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      {msg && (
        <>
          <div style={{ color: "var(--teal)", marginBottom: 10, lineHeight: 1.7 }}>{msg}</div>
          <button className="btn btn--primary" onClick={() => { window.location.hash = "payments"; onClose(); }}>前往繳費審核</button>
        </>
      )}

      {!msg && !preview && (
        <>
          {dirty && <div className="warnnote">你有尚未儲存的設定變更。發起繳費使用<b>已儲存</b>的設定（含結帳日）；如要套用新值，請先回上方「儲存變更」。</div>}
          <p style={{ color: "var(--muted-strong)", fontSize: 13, margin: "0 0 12px", lineHeight: 1.7 }}>
            修改金額即為該方案的<b>新定價</b>（下期沿用）；已繳／已驗證的紀錄不受影響。下一步會先列出這次會改動的帳單與定價，確認後才真的送出。
          </p>
          <Field label="期別"><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} /></Field>
          {next && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "-4px 0 14px", fontSize: 13, color: "var(--muted-strong)" }}>
              <input type="checkbox" checked={period === next} onChange={(e) => setPeriod(e.target.checked ? next : current)} disabled={busy} />
              預開下期（{next}）—— 只有在你要提前開下個月時才勾
            </label>
          )}
          {plans.map((p) => (
            <Field key={p.id} label={`${p.name} 金額`}>
              <input type="number" value={amounts[p.id] ?? ""} onChange={(e) => setAmounts((s) => ({ ...s, [p.id]: e.target.value }))} disabled={busy} />
            </Field>
          ))}
          <button className="btn btn--primary" onClick={runPreview} disabled={busy || invalid}>{busy ? "計算影響中…" : "預覽影響…"}</button>
        </>
      )}

      {!msg && preview && (
        <>
          <div className="stats">
            <Stat label="➕ 新增帳單" value={preview.create.length} />
            <Stat label="🔄 改價" value={preview.reprice.length} />
            <Stat label="🏷️ 方案改價" value={preview.plan_changes.length} />
            <Stat label="🔒 保留(已繳)" value={preview.frozen_count} />
          </div>
          {preview.plan_changes.length > 0 && (
            <DiffList title="方案定價（永久生效）" rows={preview.plan_changes.map((c) => `${c.plan_name} NT$${c.from.toLocaleString()} → NT$${c.to.toLocaleString()}`)} />
          )}
          {preview.create.length > 0 && <DiffList title="將建立的帳單" rows={preview.create.map((a) => `${a.user_name}·${a.plan_name} NT$${a.amount.toLocaleString()}`)} />}
          {preview.reprice.length > 0 && <DiffList title="將改價的待繳帳單" rows={preview.reprice.map((a) => `${a.user_name}·${a.plan_name} ${a.from}→${a.to}`)} />}
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.7, margin: "12px 0" }}>
            {preview.will_notify
              ? `送出後會在繳費頻道公開發出 ${preview.period} 的開繳通知並 @ 各方案身分組。`
              : `送出後${preview.notify_reason === "already_sent" ? "不會再發通知" : "不會發出通知"}：${NOTIFY_REASON_TEXT[preview.notify_reason] ?? preview.notify_reason}。`}
            {preview.frozen_count > 0 && `　已繳／已驗證的 ${preview.frozen_count} 筆一律原樣保留。`}
          </p>
          <div className="btn-row">
            <button className="btn" onClick={() => setPreview(null)} disabled={busy}>回上一步</button>
            <button className="btn btn--danger" onClick={apply} disabled={busy}>
              {preview.will_notify ? "確認發起並通知" : "確認發起（不會發通知）"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function RebuildMessage({ onDone }: { onDone: (messageId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.rebuildPaymentMessage(); setMsg(`✓ 已建立／更新（id ${r.message_id}）`); onDone(r.message_id); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <button className="btn btn--sm" onClick={run} disabled={busy}>{busy ? "處理中…" : "重建"}</button>
      {err && <span className="act-feedback" style={{ color: "var(--red)" }}>{err}</span>}
      {msg && <span className="act-feedback" style={{ color: "var(--teal)" }}>{msg}</span>}
    </>
  );
}

function RebuildBindMessage({ onDone }: { onDone: (messageId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.rebuildBindMessage(); setMsg(`✓ 已張貼／更新（id ${r.message_id}）`); onDone(r.message_id); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <button className="btn btn--sm" onClick={run} disabled={busy}>{busy ? "處理中…" : "張貼／更新"}</button>
      {err && <span className="act-feedback" style={{ color: "var(--red)" }}>{err}</span>}
      {msg && <span className="act-feedback" style={{ color: "var(--teal)" }}>{msg}</span>}
    </>
  );
}

function RegisterCommands({ onDone }: { onDone: (registeredAt: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.registerCommands(); setMsg(`✓ 已註冊 ${r.registered} 個指令`); onDone(r.registered_at); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <button className="btn btn--sm" onClick={run} disabled={busy}>{busy ? "處理中…" : "註冊"}</button>
      {err && <span className="act-feedback" style={{ color: "var(--red)" }}>{err}</span>}
      {msg && <span className="act-feedback" style={{ color: "var(--teal)" }}>{msg}</span>}
    </>
  );
}
