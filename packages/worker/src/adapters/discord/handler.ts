import type { Env } from "../../env";
import { parseSettings } from "../../env";
import { json } from "../../http";
import { periodForBillingDay } from "../../core/time";
import {
  getWorkspaceIdByGuild, getUserByDiscordId, listActiveSubscriptions,
  listActiveChannelTags, listSettleablePayments, listOpenPayablePeriods, listRecentPayments, listUnboundUsers, searchUnboundUsers, bindDiscordId, unbindDiscordId,
  type UnboundUser,
} from "../../core/db";
import { ensurePeriodPayment, initiateBillingOpened } from "../../core/billing";
import { isBillingOpened } from "../../core/notify";
import { settleUserPeriod, assertImageOk, extForContentType, InvalidImage } from "../../core/storage";
import { writeAudit } from "../../core/audit";
import { issueUploadToken } from "../../core/tokens";
import { discordNotifier } from "./notify";
import { editOriginalResponse } from "./api";
import {
  IT_COMMAND, IT_COMPONENT, IT_AUTOCOMPLETE, IT_MODAL_SUBMIT,
  RT_MESSAGE, RT_DEFERRED, RT_UPDATE_MESSAGE, RT_AUTOCOMPLETE, FLAG_EPHEMERAL,
  PAY_BUTTON_PREFIX, PAY_WEB_PREFIX, PAY_SELECT_PREFIX, PAY_PERIOD_PREFIX, INITIATE_MODAL_PREFIX, BIND_SELECT_PREFIX, BIND_BUTTON_PREFIX, BIND_SEARCH_MODAL_PREFIX, REBIND_PREFIX, REBIND_CONFIRM_PREFIX,
  channelSelectRow, periodSelectRow, initiateModal, bindSelectRow, bindSearchModal, rebindRow, webLinkButton, CT_ACTION_ROW,
} from "./commands";

export interface DiscordAttachment {
  url: string;
  content_type?: string;
  size?: number;
  filename?: string;
}
export interface DiscordInteraction {
  type: number;
  id: string;
  token: string;
  guild_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: { name: string; value?: string; focused?: boolean }[];
    resolved?: { attachments?: Record<string, DiscordAttachment> };
    components?: { components: { custom_id: string; value: string }[] }[];
  };
}

const ephemeral = (content: string) =>
  json({ type: RT_MESSAGE, data: { content, flags: FLAG_EPHEMERAL } });

function discordUserId(i: DiscordInteraction): string | null {
  return i.member?.user?.id ?? i.user?.id ?? null;
}
function getOption(i: DiscordInteraction, name: string) {
  return i.data?.options?.find((o) => o.name === name);
}

/** Entry point: dispatch a (signature-verified) interaction. `ctx` enables waitUntil. */
export function routeInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Response | Promise<Response> {
  switch (interaction.type) {
    case IT_AUTOCOMPLETE:
      return handleAutocomplete(interaction, env);
    case IT_COMMAND:
      return handleCommand(interaction, env, ctx);
    case IT_COMPONENT:
      return handleComponent(interaction, env, ctx);
    case IT_MODAL_SUBMIT:
      return handleModalSubmit(interaction, env, ctx);
    default:
      return ephemeral("未支援的互動。");
  }
}

// ── Autocomplete: 渠道 → active channel tags ─────────────────────────────────

async function handleAutocomplete(i: DiscordInteraction, env: Env): Promise<Response> {
  const choices: { name: string; value: string }[] = [];
  if (i.guild_id) {
    const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
    if (ws) {
      if (i.data?.name === "綁定") {
        // /綁定 名字: type-to-search the unbound roster (value = user id) — scales past the 25 cap.
        const q = String(getOption(i, "名字")?.value ?? "").trim();
        for (const u of await searchUnboundUsers(env.DB, ws, q, 25)) choices.push({ name: u.display_name, value: String(u.id) });
      } else {
        const tags = await listActiveChannelTags(env.DB, ws);
        for (const t of tags.slice(0, 25)) choices.push({ name: t.name, value: String(t.id) });
      }
    }
  }
  return json({ type: RT_AUTOCOMPLETE, data: { choices } });
}

// ── Shared member resolution ─────────────────────────────────────────────────

/** Resolve guild→workspace + the caller's Discord id (no membership requirement). */
async function resolveWs(
  i: DiscordInteraction, env: Env
): Promise<{ ws: number; discordId: string } | Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  const did = discordUserId(i);
  if (!did) return ephemeral("無法辨識你的 Discord 帳號。");
  return { ws, discordId: did };
}

/** Resolve a registered (bound) member, or an ephemeral error Response. */
async function resolveMember(
  i: DiscordInteraction, env: Env
): Promise<{ ws: number; userId: number } | Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const user = await getUserByDiscordId(env.DB, r.ws, r.discordId);
  if (!user) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");
  return { ws: r.ws, userId: user.id };
}

// ── Commands ─────────────────────────────────────────────────────────────────

function handleCommand(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  if (i.data?.name === "繳費") {
    // Defer immediately (ephemeral); do all work in the background, then edit the reply.
    ctx.waitUntil(deferredReply(i, env, ctx));
    return json({ type: RT_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
  }
  if (i.data?.name === "發起繳費") return handleInitiateCommand(i, env);
  if (i.data?.name === "我的帳單") return handleMyBillsCommand(i, env);
  if (i.data?.name === "綁定") return handleBindCommand(i, env);
  return ephemeral("未知指令。");
}

/** Guarantees exactly one followup edit — never leaves the deferred reply hanging. */
async function deferredReply(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<void> {
  let content: string;
  try {
    content = await computePayResult(i, env, ctx);
  } catch (err) {
    console.error("pay command failed", err);
    content = "處理失敗，請稍後再試。";
  }
  await editOriginalResponse(env.DISCORD_APPLICATION_ID ?? "", i.token, { content }).catch(() => {});
}

function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" &&
      (u.hostname === "cdn.discordapp.com" || u.hostname === "media.discordapp.net");
  } catch {
    return false;
  }
}

/** `/繳費`: settle ALL of the user's period subs. 渠道 / 截圖 / 備註 — at least one. */
async function computePayResult(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<string> {
  const m = await resolveWs(i, env);
  if (m instanceof Response) return ((await m.json()) as any).data.content;
  const { ws, discordId } = m;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) return "你還沒綁定 Discord 帳號，請點「繳費」按鈕或用 `/綁定` 完成綁定後再試。";
  const userId = user.id;

  const subs = await listActiveSubscriptions(env.DB, ws, userId);
  if (subs.length === 0) return "你目前沒有有效訂閱。";
  const { period: current, opened } = await ensureCurrentPeriodRows(env, ws, subs);

  // Payable = opened AND still owed (oldest first); includes a pre-opened next month. The slash
  // command settles one period, so if several are owed we send them to the button (which can pick).
  const periods = await listOpenPayablePeriods(env.DB, ws, userId);
  if (periods.length === 0) {
    return opened ? "✅ 你已登記繳費，目前沒有待繳項目。" : `${current} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`;
  }
  if (periods.length > 1) return `你有多個月份待繳：${periods.join("、")}。請改用下方「繳費」按鈕選擇要繳的月份。`;
  const period = periods[0]!;
  const note = getOption(i, "備註")?.value?.trim() || null;

  // Resolve declared channel (autocomplete value is a channel_tag id).
  let declaredChannelTagId: number | null = null;
  const chanOpt = getOption(i, "渠道")?.value;
  if (chanOpt) {
    const tagId = Number(chanOpt);
    const tags = await listActiveChannelTags(env.DB, ws);
    if (!tags.some((t) => t.id === tagId)) return "選擇的渠道無效，請重新選擇。";
    declaredChannelTagId = tagId;
  }

  // Optional screenshot — only when R2 is configured; otherwise ignore the attachment.
  let proof: { body: ArrayBuffer; ext: string; contentType: string } | null = null;
  const attachOpt = getOption(i, "截圖");
  const attachment = attachOpt?.value ? i.data?.resolved?.attachments?.[attachOpt.value] : undefined;
  const screenshotIgnored = !!attachment && !env.BUCKET;
  if (attachment && env.BUCKET) {
    const ct = attachment.content_type ?? "";
    try { assertImageOk(ct, attachment.size ?? 0); }
    catch (e) { if (e instanceof InvalidImage) return "截圖格式不支援或檔案過大，請改用備註或渠道。"; throw e; }
    if (!isDiscordCdnUrl(attachment.url)) return "截圖來源無效。";
    const res = await fetch(attachment.url);
    if (!res.ok) return "下載截圖失敗，請稍後再試。";
    const body = await res.arrayBuffer();
    try { assertImageOk(ct, body.byteLength); } catch { return "截圖檔案過大。"; }
    proof = { body, ext: extForContentType(ct), contentType: ct };
  }

  // At-least-one rule (slash): 渠道 / 截圖 / 備註.
  if (!declaredChannelTagId && !proof && !note) {
    if (screenshotIgnored) return "本站未開啟截圖功能，請改用「渠道」或「備註」登記繳費。";
    return "渠道、截圖、備註至少填一項。";
  }

  const r = await settleUserPeriod(env, {
    workspaceId: ws, userId, period, source: "user_slash",
    declaredChannelTagId, paymentNote: note, proof,
    waitUntil: (p) => ctx.waitUntil(p), // notify in the background (followup reply stays snappy)
  });
  if (r.paidCount === 0) return `${period} 已登記繳費，無需重複操作。`;
  const ignoredNote = screenshotIgnored ? "（本站未開啟截圖功能，已記錄你的繳費宣告）" : "";
  return `✅ 已登記 ${period} 繳費 NT$${r.totalAmount.toLocaleString()}（共 ${r.paidCount} 筆）。管理員確認收款後完成。${ignoredNote}`;
}

// ── 發起繳費 (admin): modal open + modal submit ──────────────────────────────

async function isAdmin(env: Env, ws: number, discordId: string | null): Promise<boolean> {
  if (!discordId) return false;
  const row = await env.DB.prepare("SELECT settings FROM workspaces WHERE id = ?").bind(ws).first<{ settings: string }>();
  if (!row) return false;
  return parseSettings(row.settings).admin_discord_ids.includes(discordId);
}

/** Discord modals cap at 5 text inputs; more plans than that cannot be confirmed here. */
const INITIATE_PLAN_CAP = 5;

interface InitiatePlan { id: number; name: string; monthly_amount: number }

/**
 * The active plans a 發起繳費 modal has to cover — or the sentence explaining why it cannot be built.
 *
 * Refuse rather than silently confirm only the first five: the notice lists EVERY active plan, so a
 * truncated modal would broadcast the untouched plans at their old prices while the reply claims the
 * amounts were confirmed. Both the command and the modal SUBMIT go through here: the active set can
 * change while the form sits open, and it is the set at submit time that the notice will list.
 */
async function initiatePlans(env: Env, ws: number): Promise<{ plans: InitiatePlan[]; refusal?: undefined } | { plans?: undefined; refusal: string }> {
  const plans = (await env.DB
    .prepare("SELECT id, name, monthly_amount FROM plans WHERE workspace_id = ? AND active = 1 ORDER BY id")
    .bind(ws)
    .all<InitiatePlan>()).results;
  if (plans.length === 0) return { refusal: "沒有啟用中的方案。" };
  if (plans.length > INITIATE_PLAN_CAP) {
    return {
      refusal:
        `目前有 ${plans.length} 個啟用中的方案，超過 Discord 表單的 ${INITIATE_PLAN_CAP} 欄上限，` +
        "無法在這裡確認全部金額。請改用後台「設定 → 工具 → 發起繳費」。",
    };
  }
  return { plans };
}

async function handleInitiateCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  if (!(await isAdmin(env, ws, discordUserId(i)))) return ephemeral("你沒有發起繳費的權限。");

  const avail = await initiatePlans(env, ws);
  if (avail.refusal !== undefined) return ephemeral(avail.refusal);

  // Default to the period currently being collected — the same default the dashboard, the payments
  // list and the admin 發起繳費 modal use. To pre-open a later month, pass 期別 explicitly.
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(ws).first<{ billing_day: number }>();
  const typed = getOption(i, "期別")?.value?.trim();
  const period = typed || periodForBillingDay(wsRow?.billing_day ?? 1);
  if (!PERIOD_RE.test(period)) return ephemeral("期別格式需為 `YYYY-MM`，例如 `2026-07`。");
  return json(initiateModal(ws, period, avail.plans));
}

async function handleModalSubmit(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cid = i.data?.custom_id ?? "";
  if (cid.startsWith(BIND_SEARCH_MODAL_PREFIX)) return handleBindSearchSubmit(i, env);
  if (cid.startsWith(INITIATE_MODAL_PREFIX)) {
    ctx.waitUntil(deferredInitiate(i, env));
    return json({ type: RT_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
  }
  return ephemeral("未支援的表單。");
}

/**
 * zh-TW for an apply's notify_reason. The old reply said "先前已發送" for every non-send, which was
 * a guess: a missing channel, an empty plan list and a refused send all reached that sentence.
 */
function initiateNoticeNote(reason: string, period: string): string {
  switch (reason) {
    case "already_sent": return `${period} 的開繳通知先前已發送，未重複發送。`;
    case "no_channel": return "尚未設定繳費頻道 ID，未發出開繳通知。";
    case "no_bot_token": return "尚未設定 Discord bot token，未發出開繳通知。";
    case "no_plans": return `沒有任何「啟用中方案 × 有效訂閱」，未發出開繳通知（${period} 仍維持未開繳）。`;
    case "send_failed": return `開繳通知發送失敗（${period} 已開繳、帳單已建立），請稍後到後台「推播狀態 → 重發開繳通知」再試一次。`;
    default: return "未發出開繳通知。";
  }
}

async function deferredInitiate(i: DiscordInteraction, env: Env): Promise<void> {
  let content: string;
  try {
    const parts = (i.data!.custom_id ?? "").split(":"); // chippot:initiate:<ws>:<period>
    const ws = Number(parts[2]);
    const period = parts[3]!;
    // Re-validate the active set at SUBMIT time, not just when the modal opened: a plan activated
    // while the form was on screen would otherwise be broadcast at its old price by a reply that
    // claims every amount was confirmed. Same refusal sentence as the command.
    const avail = await initiatePlans(env, ws);
    if (!(await isAdmin(env, ws, discordUserId(i)))) {
      content = "你沒有發起繳費的權限。";
    } else if (avail.refusal) {
      content = avail.refusal;
    } else {
      const amounts: { plan_id: number; amount: number }[] = [];
      for (const row of i.data!.components ?? []) {
        for (const c of row.components) {
          if (!c.custom_id.startsWith("amt:")) continue;
          const raw = String(c.value).trim();
          // Only plain non-negative integers; blank / "1e3" / decimals are skipped (no change).
          if (!/^\d+$/.test(raw)) continue;
          const plan_id = Number(c.custom_id.slice(4));
          if (Number.isInteger(plan_id)) amounts.push({ plan_id, amount: Number(raw) });
        }
      }
      const r = await initiateBillingOpened(env, ws, period, { amounts }, `discord:${discordUserId(i)}`, discordNotifier);
      const writes = `新增 ${r.createdPayments} 筆帳單、更新 ${r.updatedPlans} 個方案定價、${r.updatedPayments} 筆待繳金額`;
      content = r.sent
        ? `✅ 已發起 ${period} 繳費並發出通知（${writes}）。`
        : `${r.notifyReason === "send_failed" ? "⚠️" : "✅"} 已更新 ${period} 金額（${writes}）。${initiateNoticeNote(r.notifyReason, period)}`;
    }
  } catch (err) {
    console.error("initiate modal failed", err);
    content = "發起繳費失敗，請稍後再試。";
  }
  await editOriginalResponse(env.DISCORD_APPLICATION_ID ?? "", i.token, { content }).catch(() => {});
}

// ── Components: persistent button → channel select → settle ──────────────────

function handleComponent(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cid = i.data?.custom_id ?? "";
  if (cid.startsWith(REBIND_CONFIRM_PREFIX)) return handleRebindConfirm(i, env); // before REBIND (prefix overlap)
  if (cid.startsWith(REBIND_PREFIX)) return handleRebindAsk(i, env);
  if (cid.startsWith(BIND_BUTTON_PREFIX)) return handleBindButton(i, env); // before BIND_SELECT (prefix overlap)
  if (cid.startsWith(BIND_SELECT_PREFIX)) return handleBindSelect(i, env);
  if (cid.startsWith(PAY_SELECT_PREFIX)) return handlePaySelect(i, env, ctx);
  if (cid.startsWith(PAY_PERIOD_PREFIX)) return handlePayPeriodSelect(i, env); // before PAY_BUTTON (prefix overlap)
  if (cid.startsWith(PAY_WEB_PREFIX)) return handlePayWebLink(i, env); // before PAY_BUTTON (prefix overlap)
  if (cid.startsWith(PAY_BUTTON_PREFIX)) return handlePayButton(i, env);
  return Promise.resolve(ephemeral("未支援的按鈕。"));
}

// Discord string-selects cap at 25 options. Above this, the unbound roster can't fit one select, so
// we switch to type-to-search (modal on the button, autocomplete on /綁定) instead of truncating.
const BIND_SELECT_CAP = 25;

const bindSelectMsg = (
  ws: number, origin: "pay" | "cmd", unbound: UnboundUser[],
  content = "請選擇你的名字以綁定 Discord 帳號（只列出尚未綁定的成員）。"
) => json({ type: RT_MESSAGE, data: { flags: FLAG_EPHEMERAL, content, components: [bindSelectRow(ws, origin, unbound)] } });

/** Already bound: name the binding AND offer the way out (C4) — the old dead end just said
 *  「你已綁定為 X」 and left 綁錯名字的人 with nothing but "go ask an admin". */
const boundAlready = (ws: number, name: string) =>
  json({
    type: RT_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `你已綁定為 ${name}。如果這不是你，可以按下方按鈕解除後重新綁定。`,
      components: [rebindRow(ws, false)],
    },
  });

/** Bind a specific roster user id to this Discord account (used by /綁定 名字 autocomplete pick). */
async function bindPickedUser(env: Env, ws: number, userId: number, discordId: string): Promise<Response> {
  if (!Number.isInteger(userId)) return ephemeral("請從清單選擇你的名字。");
  const result = await bindDiscordId(env, ws, userId, discordId);
  if (result.status === "ok") return ephemeral(`✅ 已綁定為 ${result.boundName}。之後點「繳費」按鈕或用 \`/繳費\` 即可登記繳費。`);
  if (result.status === "already_bound_other") return ephemeral(`你的 Discord 帳號已綁定為 ${result.boundName}。`);
  if (result.status === "name_taken") return ephemeral("這個名字剛被綁定了，請重新操作。");
  return ephemeral("找不到該成員，請從清單重新選擇或聯絡管理員。");
}

/** `/綁定` slash command: bind the picked name (autocomplete), or show the picker / search hint. */
// The member-facing status vocabulary. Mirrors the admin badge labels, with 'paid' spelled out as
// 已繳待驗 — 「已繳」 alone reads as "the money arrived", which is exactly what it doesn't mean.
const MY_BILL_STATUS: Record<string, string> = {
  pending: "待繳", paid: "已繳待驗", verified: "已驗證", rejected: "已退回",
};

/** `/我的帳單`: what you owe right now + your recent history, ephemeral. Reuses the same two
 *  queries the pay prompt uses, so the numbers can never disagree with the button (C3/C6). */
async function handleMyBillsCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) return ephemeral("你還沒綁定 Discord 帳號，請點「綁定 Discord」按鈕或用 `/綁定` 完成綁定後再試。");

  const periods = await listOpenPayablePeriods(env.DB, ws, user.id);
  const blocks: string[] = [];
  let grandTotal = 0;
  for (const period of periods) {
    const rows = await listSettleablePayments(env.DB, ws, user.id, period);
    if (rows.length === 0) continue;
    const sub = rows.reduce((s, x) => s + x.amount, 0);
    grandTotal += sub;
    blocks.push(`**${period}**\n${rows.map((x) => `・${x.plan_name} NT$${x.amount.toLocaleString()}`).join("\n")}`);
  }

  const recent = await listRecentPayments(env.DB, ws, user.id, 6);
  const history = recent.length
    ? recent.map((p) => `・${p.period} ${p.plan_name} NT$${p.amount.toLocaleString()}（${MY_BILL_STATUS[p.status] ?? p.status}）`).join("\n")
    : "（還沒有任何紀錄）";

  const owed = blocks.length
    ? `${blocks.join("\n")}\n**合計 NT$${grandTotal.toLocaleString()}**\n請點頻道裡的「繳費」按鈕或用 \`/繳費\` 登記。`
    : "目前沒有待繳項目 🎉";

  return ephemeral(`📄 **${user.display_name} 的帳單**\n\n__待繳__\n${owed}\n\n__最近紀錄__\n${history}`);
}

async function handleBindCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (existing) return boundAlready(ws, existing.display_name);
  const picked = getOption(i, "名字")?.value;
  if (picked != null && String(picked).trim() !== "") return bindPickedUser(env, ws, Number(picked), discordId);
  const unbound = await listUnboundUsers(env.DB, ws);
  if (unbound.length === 0) return ephemeral("目前沒有可綁定的成員，請聯絡管理員。");
  if (unbound.length > BIND_SELECT_CAP) return ephemeral("名單較多，請重新輸入 `/綁定`，並在「名字」欄輸入你的名字搜尋選擇。");
  return bindSelectMsg(ws, "cmd", unbound);
}

/** Persistent public bind button: picker for ≤25 unbound, otherwise a name-search modal. */
async function handleBindButton(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (existing) return boundAlready(ws, existing.display_name);
  const unbound = await listUnboundUsers(env.DB, ws);
  if (unbound.length === 0) return ephemeral("目前沒有可綁定的成員，請聯絡管理員。");
  if (unbound.length > BIND_SELECT_CAP) return json(bindSearchModal(ws, "cmd"));
  return bindSelectMsg(ws, "cmd", unbound);
}

/** Name-search modal submit (button / pay-bind when roster > 25): show a filtered picker. */
async function handleBindSearchSubmit(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (existing) return ephemeral(`你已綁定為 ${existing.display_name}。`);
  const origin: "pay" | "cmd" = (i.data?.custom_id ?? "").split(":")[3] === "pay" ? "pay" : "cmd";
  let q = "";
  for (const row of i.data?.components ?? []) for (const c of row.components) if (c.custom_id === "q") q = String(c.value ?? "").trim();
  if (!q) return ephemeral("請輸入名字後再送出。");
  const matches = await searchUnboundUsers(env.DB, ws, q, BIND_SELECT_CAP + 1);
  if (matches.length === 0) return ephemeral(`找不到包含「${q}」的未綁定成員，請重試或聯絡管理員。`);
  const note = matches.length > BIND_SELECT_CAP ? "（符合的太多，只顯示前 25 筆；沒看到請打更完整的名字並重新點按鈕）" : "";
  return bindSelectMsg(ws, origin, matches.slice(0, BIND_SELECT_CAP), `符合「${q}」的成員${note}，請選擇你的名字：`);
}

async function handleBindSelect(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const updateErr = (content: string) =>
    json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });

  const parts = (i.data?.custom_id ?? "").split(":"); // chippot:bind:<ws>:<origin>
  const origin = parts[3];
  if (parts.length !== 4 || Number(parts[2]) !== ws || (origin !== "pay" && origin !== "cmd")) {
    return updateErr("這個綁定選單已失效，請重新操作。");
  }
  const targetUserId = Number(i.data?.values?.[0]);
  if (!Number.isInteger(targetUserId)) return updateErr("選擇無效，請重新操作。");

  const result = await bindDiscordId(env, ws, targetUserId, discordId);
  if (result.status === "already_bound_other") return updateErr(`你的 Discord 帳號已綁定為 ${result.boundName}。`);
  if (result.status === "name_taken") return updateErr("這個名字剛被綁定了，請重新操作。");
  if (result.status === "not_found") return updateErr("找不到該成員，請重新操作。");

  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordId}`, action: "member.bind",
    entityType: "user", entityId: targetUserId, after: { discord_id: discordId },
  });

  if (origin === "pay") {
    const prompt = await buildPayPrompt(env, ws, targetUserId);
    return json({
      type: RT_UPDATE_MESSAGE,
      data: { content: `✅ 已綁定為 ${result.boundName}。\n${prompt.content}`, components: prompt.components },
    });
  }
  return updateErr(`✅ 已綁定為 ${result.boundName}。之後點「繳費」按鈕或用 \`/繳費\` 即可登記繳費。`);
}

/** "這不是我" → name the binding we are about to release and ask for a second click. */
async function handleRebindAsk(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  if (Number((i.data?.custom_id ?? "").split(":")[2]) !== ws) {
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "這個按鈕已失效，請重新用 `/綁定`。", components: [] } });
  }
  const existing = await getUserByDiscordId(env.DB, ws, discordId);
  if (!existing) return json({ type: RT_UPDATE_MESSAGE, data: { content: "你的 Discord 帳號目前尚未綁定，可直接選擇你的名字。", components: [] } });
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      content: `確定要解除「${existing.display_name}」的綁定嗎？解除後這個名字會回到可綁定清單，你必須重新選一次自己的名字才能繳費。`,
      components: [rebindRow(ws, true)],
    },
  });
}

/** "確定解除綁定" → release ONLY the caller's own row, audit it, and go straight back to the picker. */
async function handleRebindConfirm(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const result = await unbindDiscordId(env, ws, discordId);
  if (result.status !== "ok") {
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "你的 Discord 帳號目前尚未綁定。", components: [] } });
  }
  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordId}`, action: "member.unbind",
    entityType: "user", entityId: result.userId!, before: { discord_id: discordId }, after: { discord_id: null },
  });
  // Straight back into the picker: the point of unbinding is to bind to the right name.
  const unbound = await listUnboundUsers(env.DB, ws);
  if (unbound.length === 0) return json({ type: RT_UPDATE_MESSAGE, data: { content: `已解除「${result.name}」的綁定。目前沒有可綁定的成員，請聯絡管理員。`, components: [] } });
  if (unbound.length > BIND_SELECT_CAP) return json(bindSearchModal(ws, "cmd"));
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `已解除「${result.name}」的綁定，請重新選擇你的名字：`,
      components: [bindSelectRow(ws, "cmd", unbound)],
    },
  });
}

// Make sure the current collection period has rows for these subs when it's open, so a member who
// joined mid-period can still pay it. Pre-opened future periods already got their rows at 發起繳費
// time, so listOpenPayablePeriods will surface them too.
async function ensureCurrentPeriodRows(env: Env, ws: number, subs: { id: number }[]): Promise<{ period: string; opened: boolean }> {
  const wsRow = await env.DB.prepare("SELECT billing_day FROM workspaces WHERE id = ?").bind(ws).first<{ billing_day: number }>();
  const current = periodForBillingDay(wsRow?.billing_day ?? 1);
  const opened = await isBillingOpened(env.DB, ws, current);
  if (opened) for (const s of subs) await ensurePeriodPayment(env.DB, s.id, current);
  return { period: current, opened };
}

/** The pay prompt shown after the button (or after a button-originated bind). Offers the periods
 *  the member can pay (opened + owed): none → done; one → straight to the channel select; many →
 *  pick the month first. */
async function buildPayPrompt(
  env: Env, ws: number, userId: number
): Promise<{ content: string; components: unknown[] }> {
  const subs = await listActiveSubscriptions(env.DB, ws, userId);
  if (subs.length === 0) return { content: "你目前沒有有效訂閱。", components: [] };
  const { period: current, opened } = await ensureCurrentPeriodRows(env, ws, subs);
  const periods = await listOpenPayablePeriods(env.DB, ws, userId);
  if (periods.length === 0) {
    return {
      content: opened ? "✅ 你已登記繳費，目前沒有待繳項目。" : `${current} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`,
      components: [],
    };
  }
  const tags = await listActiveChannelTags(env.DB, ws);
  if (tags.length === 0) {
    // Don't point at a capability this deployment doesn't have (C7): with no R2 there is no
    // screenshot path, so the only thing left to offer is a note.
    return {
      content: env.BUCKET
        ? "管理員尚未設定繳費渠道，請改用 `/繳費` 指令（可附截圖或備註）。"
        : "管理員尚未設定繳費渠道，請改用 `/繳費` 指令並填寫備註（本站未開啟截圖上傳）。",
      components: [],
    };
  }
  if (periods.length > 1) {
    return {
      content: `你有多個月份待繳：${periods.join("、")}。\n請先選擇要繳的月份。`,
      components: [periodSelectRow(ws, periods)],
    };
  }
  return payChannelPrompt(env, ws, userId, periods[0]!, tags);
}

/** The channel-select prompt for one specific period (shared by the single-period button path and
 *  the period chooser). */
async function payChannelPrompt(
  env: Env, ws: number, userId: number, period: string, tags: { id: number; name: string }[]
): Promise<{ content: string; components: unknown[] }> {
  const settleable = await listSettleablePayments(env.DB, ws, userId, period);
  if (settleable.length === 0) return { content: "✅ 這個月份已登記繳費，無需重複操作。", components: [] };
  const total = settleable.reduce((s, r) => s + r.amount, 0);
  const lines = settleable.map((r) => `・${r.plan_name}：NT$${r.amount.toLocaleString()}`).join("\n");
  const canWeb = !!env.BUCKET && !!env.WEB_ORIGIN;
  const elsewhere = env.BUCKET
    ? (canWeb ? "想附截圖或備註？改用 `/繳費`，或按下方「改用網頁上傳」。" : "想附截圖或備註？改用 `/繳費`。")
    : "想附備註？改用 `/繳費`（本站未開啟截圖上傳）。";
  return {
    // Say what THIS entry point can and cannot do before the member commits to it (C8): the button
    // only picks a channel, and whether a screenshot is even possible depends on R2 (C7).
    content: `${period} 應繳：\n${lines}\n**合計 NT$${total.toLocaleString()}**\n\n請選擇繳費渠道送出（這個按鈕只能選渠道）。${elsewhere}`,
    // Discord forbids mixing a select and a button in one action row — the button gets its own.
    components: canWeb
      ? [channelSelectRow(ws, period, tags), { type: CT_ACTION_ROW, components: [webLinkButton(ws, period)] }]
      : [channelSelectRow(ws, period, tags)],
  };
}

/** Member owed >1 period and picked a month → show that month's channel select. */
/** Mint a one-time upload link for the member's own period, so the web page is reachable at all
 *  (C5). The token is created on click — not when the prompt is drawn — so browsing the prompt
 *  never litters upload_tokens. */
async function handlePayWebLink(i: DiscordInteraction, env: Env): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;
  const updateErr = (content: string) => json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });

  const parts = (i.data?.custom_id ?? "").split(":"); // chippot:payweb:<ws>:<period>
  const period = parts[3] ?? "";
  if (!PERIOD_RE.test(period) || Number(parts[2]) !== ws) return updateErr("這個按鈕已失效，請重新點「繳費」按鈕。");
  if (!env.BUCKET || !env.WEB_ORIGIN) return updateErr("本站未開啟網頁上傳，請直接用 `/繳費` 指令登記。");

  // Same gate as the channel path: never mint a token for a period the member can't settle.
  const periods = await listOpenPayablePeriods(env.DB, ws, userId);
  if (!periods.includes(period)) return updateErr("這個月份已無待繳項目，請重新點「繳費」按鈕。");

  const { raw, expiresAt } = await issueUploadToken(env.DB, { workspaceId: ws, userId, period, ttlMs: 30 * 60 * 1000 });
  await writeAudit(env.DB, {
    workspaceId: ws, actor: `discord:${discordUserId(i)}`, action: "upload_link.create",
    entityType: "user", entityId: userId, after: { period, expires_at: expiresAt, source: "discord_button" },
  });
  const url = `${env.WEB_ORIGIN.replace(/\/$/, "")}/u/${raw}`;
  return json({
    type: RT_UPDATE_MESSAGE,
    data: {
      content: `${period} 繳費網頁（只有你看得到這則訊息）：\n${url}\n\n連結 30 分鐘內有效、只能使用一次，可附截圖與備註。`,
      components: [],
    },
  });
}

async function handlePayPeriodSelect(i: DiscordInteraction, env: Env): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;
  const updateErr = (content: string) => json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });
  if (Number((i.data?.custom_id ?? "").split(":")[2]) !== ws) return updateErr("這個選單已失效，請重新點「繳費」按鈕。");
  const period = i.data?.values?.[0] ?? "";
  const periods = await listOpenPayablePeriods(env.DB, ws, userId);
  if (!periods.includes(period)) return updateErr("這個月份已無待繳項目，請重新點「繳費」按鈕。");
  const tags = await listActiveChannelTags(env.DB, ws);
  if (tags.length === 0) return updateErr("管理員尚未設定繳費渠道，請改用 `/繳費` 指令。");
  const prompt = await payChannelPrompt(env, ws, userId, period, tags);
  return json({ type: RT_UPDATE_MESSAGE, data: { content: prompt.content, components: prompt.components } });
}

async function handlePayButton(i: DiscordInteraction, env: Env): Promise<Response> {
  const r = await resolveWs(i, env);
  if (r instanceof Response) return r;
  const { ws, discordId } = r;
  const user = await getUserByDiscordId(env.DB, ws, discordId);
  if (!user) {
    // Unbound: offer self-bind (origin=pay) — picker for ≤25, name-search modal beyond the cap.
    const unbound = await listUnboundUsers(env.DB, ws);
    if (unbound.length === 0) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");
    if (unbound.length > BIND_SELECT_CAP) return json(bindSearchModal(ws, "pay"));
    return bindSelectMsg(ws, "pay", unbound);
  }
  const prompt = await buildPayPrompt(env, ws, user.id);
  return json({ type: RT_MESSAGE, data: { flags: FLAG_EPHEMERAL, content: prompt.content, components: prompt.components } });
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function handlePaySelect(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = await resolveMember(i, env);
  if (m instanceof Response) return m;
  const { ws, userId } = m;

  const updateErr = (content: string) =>
    json({ type: RT_UPDATE_MESSAGE, data: { content, components: [] } });

  // Strictly parse chippot:paysel:<ws>:<period>; the ws must match the resolved workspace.
  const parts = (i.data?.custom_id ?? "").split(":");
  const period = parts[3] ?? "";
  if (!PERIOD_RE.test(period) || Number(parts[2]) !== ws) {
    return updateErr("這個繳費選單已失效，請重新點「繳費」按鈕。");
  }
  // The selected tag must be one of this workspace's active channel tags.
  const tagId = Number(i.data?.values?.[0]);
  const tags = await listActiveChannelTags(env.DB, ws);
  if (!Number.isInteger(tagId) || !tags.some((t) => t.id === tagId)) {
    return updateErr("渠道無效，請重新點「繳費」按鈕再選一次。");
  }
  // Defense in depth: even with a crafted select, don't settle before billing is opened.
  if (!(await isBillingOpened(env.DB, ws, period))) {
    return updateErr(`${period} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`);
  }

  try {
    const r = await settleUserPeriod(env, {
      workspaceId: ws, userId, period, declaredChannelTagId: tagId, source: "user_slash",
      waitUntil: (p) => ctx.waitUntil(p), // notify in the background — keep the interaction < 3s
    });
    if (r.paidCount === 0) {
      return json({ type: RT_UPDATE_MESSAGE, data: { content: `✅ ${period} 已登記繳費，無需重複操作。`, components: [] } });
    }
    return json({
      type: RT_UPDATE_MESSAGE,
      data: { content: `✅ 已登記 NT$${r.totalAmount.toLocaleString()}（共 ${r.paidCount} 筆）。管理員確認收款後完成。`, components: [] },
    });
  } catch (err) {
    console.error("pay select failed", err);
    return json({ type: RT_UPDATE_MESSAGE, data: { content: "處理失敗，請稍後再試或改用 `/繳費`。", components: [] } });
  }
}
