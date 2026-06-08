import type { Env } from "../../env";
import type { Notifier, OverduePerson, PlanOpenLine } from "../../core/notify";
import { renderTemplate } from "../../core/templates";
import { createChannelMessage } from "./api";
import { payButtonRow } from "./commands";

/** Discord implementation of the channel-agnostic Notifier (spec §9). */
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
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      components: [payButtonRow()],
      allowed_mentions: { parse: [], roles },
    });
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
    await createChannelMessage(env.DISCORD_BOT_TOKEN ?? "", channelId, {
      content,
      allowed_mentions: { parse: [], users },
    });
  },
};
