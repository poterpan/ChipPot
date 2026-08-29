import type { Env } from "../../env";
import type { Notifier, OverduePerson, PlanOpenLine, ReceiptTarget } from "../../core/notify";
import { renderTemplate } from "../../core/templates";
import { createChannelMessage } from "./api";
import { payButtonRow } from "./commands";

/**
 * Discord implementation of the channel-agnostic Notifier (spec §9). Each method hands back
 * createChannelMessage's `ok` untouched, so "sent" upstream means "Discord answered 2xx" and
 * nothing weaker.
 */
export const discordNotifier: Notifier = {
  async sendBillingOpened(env: Env, channelId, period, lines: PlanOpenLine[], template) {
    const plans = lines
      .map((l) => `${l.role_id ? `<@&${l.role_id}>` : `**${l.plan_name}**`}　${l.plan_name}：NT$${l.amount.toLocaleString()}`)
      .join("\n");
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const content = renderTemplate(template, { period, plans, total: total.toLocaleString() });
    // Pin mentions to exactly the plan role ids — so nothing else in the (admin-authored)
    // template content can be coerced into a ping. De-dupe: two plans can share one role
    // (e.g. Standard + Premium both → @Claude), and Discord 400s on duplicate snowflakes.
    const roles = [...new Set(lines.map((l) => l.role_id).filter((r): r is string => !!r))];
    return (await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow()],
      allowed_mentions: { parse: [], roles },
    })).ok;
  },

  async sendOverdue(env: Env, channelId, period, people: OverduePerson[], template) {
    const list = people
      .map((p) => {
        const mention = p.discord_id ? `<@${p.discord_id}>` : `**${p.user_name}**`;
        const plans = p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`).join("、");
        return `・${mention} ${plans}（合計 NT$${p.total.toLocaleString()}）`;
      })
      .join("\n");
    const content = renderTemplate(template, { period, count: String(people.length), list });
    // Pin mentions to exactly the overdue members' ids — template/display-name text can't ping.
    // De-dupe defensively (same Discord duplicate-snowflake 400 risk as roles above).
    const users = [...new Set(people.map((p) => p.discord_id).filter((d): d is string => !!d))];
    return (await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      allowed_mentions: { parse: [], users },
    })).ok;
  },

  async sendPaymentNudge(env: Env, channelId, workspaceId: number, period, people: OverduePerson[], kind) {
    const list = people
      .map((p) => {
        const mention = p.discord_id ? `<@${p.discord_id}>` : `**${p.user_name}**`;
        const plans = p.lines.map((l) => `${l.plan_name} NT$${l.amount.toLocaleString()}`).join("、");
        return `・${mention} ${plans}（合計 NT$${p.total.toLocaleString()}）`;
      })
      .join("\n");
    const head = kind === "remind" ? `🔔 ${period} 繳費提醒：` : `📋 已將你加入 ${period} 繳費名單：`;
    const content = `${head}\n${list}\n請點下方按鈕繳費。`;
    // Pin mentions to exactly the added members' ids — template/display-name text can't ping.
    const users = [...new Set(people.map((p) => p.discord_id).filter((d): d is string => !!d))];
    return (await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow(workspaceId)],
      allowed_mentions: { parse: [], users },
    })).ok;
  },

  async sendPaymentReceipt(env: Env, channelId, workspaceId: number, kind, target: ReceiptTarget, reason) {
    const who = target.discord_id ? `<@${target.discord_id}>` : `**${target.user_name}**`;
    const lines = target.lines.map((l) => `・${l.plan_name} NT$${l.amount.toLocaleString()}`).join("\n");
    const body = `${lines}\n**合計 NT$${target.total.toLocaleString()}**`;
    const content = kind === "reject"
      ? `↩️ ${who} 你的 ${target.period} 繳費被退回\n${body}\n退回原因：${reason?.trim() || "（管理員未填寫原因，請在頻道詢問）"}\n請確認後點下方「繳費」按鈕重新登記，或用 \`/繳費\` 補上截圖／備註。`
      : `✅ ${who} 已確認收到你的 ${target.period} 繳費\n${body}`;
    // Pin the mention to exactly this member's id — nothing in the reason text can be coerced
    // into a ping (the reason is admin-authored free text).
    const users = target.discord_id ? [target.discord_id] : [];
    return (await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      // 退回 puts the ball back in the member's court, so give them the way back in one tap.
      ...(kind === "reject" ? { components: [payButtonRow(workspaceId)] } : {}),
      allowed_mentions: { parse: [], users },
    })).ok;
  },
};
