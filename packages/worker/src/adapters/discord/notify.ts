import type { Env } from "../../env";
import type { Notifier } from "../../core/notify";
import { createChannelMessage } from "./api";
import { payButtonRow } from "./commands";

/** Discord implementation of the channel-agnostic Notifier (spec §9). */
export const discordNotifier: Notifier = {
  async sendBillingOpened(env: Env, channelId, period, lines) {
    const body = lines
      .map((l) => `${l.role_id ? `<@&${l.role_id}>` : `**${l.plan_name}**`}　${l.plan_name}：NT$${l.amount.toLocaleString()}`)
      .join("\n");
    const content = `📢 **${period} 開始繳費**\n${body}\n\n請點下方「繳費」按鈕，或使用 \`/繳費\` 指令（可附截圖）。`;
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow()],
      allowed_mentions: { parse: ["roles"] },
    });
  },

  async sendOverdue(env: Env, channelId, t) {
    const who = t.discord_id ? `<@${t.discord_id}>` : `**${t.user_name}**`;
    const content = `⏰ ${who} 你的 **${t.plan_name}（${t.period}）** NT$${t.amount.toLocaleString()} 尚未繳費，請儘速處理 🙏`;
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      allowed_mentions: { parse: ["users"] },
    });
  },
};
