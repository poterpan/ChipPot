import type { Env } from "../../env";
import { json } from "../../http";
import { taipeiPeriod } from "../../core/time";
import { getWorkspaceIdByGuild, getUserByDiscordId, listActiveSubscriptions } from "../../core/db";
import { ensurePeriodPayment } from "../../core/billing";
import { markPaid, InvalidPaymentTransition } from "../../core/payments";
import {
  recordProof, assertImageOk, extForContentType, InvalidImage, NoEligiblePayment,
} from "../../core/storage";
import { issueUploadToken } from "../../core/tokens";
import { editOriginalResponse } from "./api";
import {
  IT_COMMAND, IT_COMPONENT, IT_AUTOCOMPLETE,
  RT_MESSAGE, RT_DEFERRED, RT_AUTOCOMPLETE, FLAG_EPHEMERAL, PAY_BUTTON_PREFIX,
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
    options?: { name: string; value?: string; focused?: boolean }[];
    resolved?: { attachments?: Record<string, DiscordAttachment> };
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
      return handleButton(interaction, env);
    default:
      return ephemeral("未支援的互動。");
  }
}

async function handleAutocomplete(i: DiscordInteraction, env: Env): Promise<Response> {
  const choices: { name: string; value: string }[] = [];
  if (i.guild_id) {
    const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
    const did = discordUserId(i);
    if (ws && did) {
      const user = await getUserByDiscordId(env.DB, ws, did);
      if (user) {
        const subs = await listActiveSubscriptions(env.DB, ws, user.id);
        for (const s of subs.slice(0, 25)) {
          choices.push({ name: `${s.plan_name}（NT$${s.amount}）`, value: String(s.id) });
        }
      }
    }
  }
  return json({ type: RT_AUTOCOMPLETE, data: { choices } });
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

function handleCommand(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  if (i.data?.name !== "繳費") return ephemeral("未知指令。");
  // Defer immediately (ephemeral); do all work in the background, then edit the reply.
  ctx.waitUntil(deferredReply(i, env));
  return json({ type: RT_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
}

/** Guarantees exactly one followup edit — never leaves the deferred reply hanging. */
async function deferredReply(i: DiscordInteraction, env: Env): Promise<void> {
  let content: string;
  try {
    content = await computePayResult(i, env);
  } catch (err) {
    console.error("pay command failed", err);
    content = "處理失敗，請改用上傳連結再試一次。";
  }
  await editOriginalResponse(env.DISCORD_APPLICATION_ID ?? "", i.token, { content }).catch(() => {});
}

/** Resolve the member + subscription, record the payment, and return the reply text. */
async function computePayResult(i: DiscordInteraction, env: Env): Promise<string> {
  if (!i.guild_id) return "此互動需在伺服器內使用。";
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return "此伺服器尚未設定繳費系統。";
  const did = discordUserId(i);
  if (!did) return "無法辨識你的 Discord 帳號。";
  const user = await getUserByDiscordId(env.DB, ws, did);
  if (!user) return "你還不是登記的成員，請聯絡管理員新增。";

  const subs = await listActiveSubscriptions(env.DB, ws, user.id);
  if (subs.length === 0) return "你目前沒有有效訂閱。";

  const planOpt = getOption(i, "方案");
  let subscriptionId: number;
  if (planOpt?.value) {
    subscriptionId = Number(planOpt.value);
    if (!subs.some((s) => s.id === subscriptionId)) return "選擇的方案無效，請重新選擇。";
  } else if (subs.length === 1) {
    subscriptionId = subs[0]!.id;
  } else {
    return "你有多筆訂閱，請用 `方案` 參數選擇，或使用上傳頁。";
  }

  const period = taipeiPeriod();
  const noteOpt = getOption(i, "備註");
  const note = noteOpt?.value?.trim() ? noteOpt.value.trim() : null;

  const attachOpt = getOption(i, "截圖");
  const attachment = attachOpt?.value
    ? i.data?.resolved?.attachments?.[attachOpt.value]
    : undefined;

  if (attachment) {
    const ct = attachment.content_type ?? "";
    try {
      assertImageOk(ct, attachment.size ?? 0);
    } catch (e) {
      if (e instanceof InvalidImage) return "截圖格式不支援或檔案過大，請改用上傳連結。";
      throw e;
    }
    if (!isDiscordCdnUrl(attachment.url)) return "截圖來源無效，請改用上傳連結。";
    // Follow Discord's own CDN redirects; the host allowlist above is the guard.
    const res = await fetch(attachment.url);
    if (!res.ok) return "下載截圖失敗，請改用上傳連結。";
    const body = await res.arrayBuffer();
    try {
      assertImageOk(ct, body.byteLength); // re-validate the actual downloaded size
    } catch {
      return "截圖檔案過大，請改用上傳連結。";
    }
    try {
      await recordProof(env, {
        subscriptionId, workspaceId: ws, userId: user.id, period,
        body, ext: extForContentType(ct), contentType: ct, source: "user_slash", paymentNote: note,
      });
      return `✅ 已收到截圖，本期（${period}）已登記繳費。`;
    } catch (e) {
      if (e instanceof NoEligiblePayment) return `本期（${period}）已是繳費或已驗證狀態。`;
      throw e;
    }
  }

  // No attachment: require at least a note (don't register a bare /繳費).
  if (!note) {
    return "請至少附上截圖，或填寫「備註」說明繳費方式（兩者擇一即可）。";
  }
  const { paymentId } = await ensurePeriodPayment(env.DB, subscriptionId, period);
  try {
    await markPaid(env.DB, paymentId, { hasProof: false, paymentNote: note, source: "user_slash" });
    return `✅ 已登記本期（${period}）繳費（無憑證）。審核時將以你的備註與帳戶核對。`;
  } catch (e) {
    if (e instanceof InvalidPaymentTransition) return `本期（${period}）已是繳費或已驗證狀態。`;
    throw e;
  }
}

async function handleButton(i: DiscordInteraction, env: Env): Promise<Response> {
  if (!i.data?.custom_id?.startsWith(PAY_BUTTON_PREFIX)) return ephemeral("未支援的按鈕。");
  if (!i.guild_id) return ephemeral("此互動需在伺服器內使用。");
  const ws = await getWorkspaceIdByGuild(env.DB, i.guild_id);
  if (!ws) return ephemeral("此伺服器尚未設定繳費系統。");
  const did = discordUserId(i);
  if (!did) return ephemeral("無法辨識你的 Discord 帳號。");
  const user = await getUserByDiscordId(env.DB, ws, did);
  if (!user) return ephemeral("你還不是登記的成員，請聯絡管理員新增。");

  const subs = await listActiveSubscriptions(env.DB, ws, user.id);
  if (subs.length === 0) return ephemeral("你目前沒有有效訂閱。");
  const subscriptionId = subs.length === 1 ? subs[0]!.id : null; // upload page picks if multiple

  const period = taipeiPeriod();
  const { raw } = await issueUploadToken(env.DB, { workspaceId: ws, userId: user.id, period, subscriptionId });
  const base = env.WEB_ORIGIN ?? "https://pay.panspace.dev";
  return ephemeral(`🔗 你的一次性上傳連結（30 分鐘內有效）：\n${base}/u/${raw}`);
}
