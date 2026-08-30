// Register guild slash commands for ChipPot. Reads DISCORD_BOT_TOKEN + DISCORD_APPLICATION_ID
// from packages/worker/.dev.vars (gitignored) and DISCORD_GUILD_ID from env or .dev.vars.
//   node scripts/register-commands.mjs           (uses .dev.vars)
//   DISCORD_GUILD_ID=123 node scripts/register-commands.mjs
//
// Keep these payloads in sync with payCommand() / INITIATE_COMMAND in src/adapters/discord/commands.ts
// (duplicated here because this .mjs can't import the TS module without a build step).
import { readFileSync } from "node:fs";

function loadDotVars(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

const vars = { ...loadDotVars(new URL("../.dev.vars", import.meta.url).pathname), ...process.env };
const TOKEN = vars.DISCORD_BOT_TOKEN;
const APP_ID = vars.DISCORD_APPLICATION_ID;
const GUILD_ID = vars.DISCORD_GUILD_ID;
if (!TOKEN || !APP_ID || !GUILD_ID) {
  console.error("Need DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID");
  process.exit(1);
}

const PROOF_ENABLED = vars.PROOF_ENABLED !== "0";

const commands = [
  // PROOF_ENABLED mirrors payCommand(proofEnabled): set it to 0 when the deployment has no R2
  // bucket, so the 截圖 option isn't offered for a file that would be dropped (C7).
  // The admin UI's 註冊 Discord 指令 button derives this automatically; this script cannot see
  // the binding, so it defaults to on.
  {
    name: "繳費", type: 1,
    description: PROOF_ENABLED
      ? "登記繳費（一次涵蓋你所有訂閱；渠道／截圖／備註至少填一項）"
      : "登記繳費（一次涵蓋你所有訂閱；渠道／備註至少填一項）",
    options: [
      { type: 3, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
      ...(PROOF_ENABLED
        ? [{ type: 11, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false }]
        : []),
      { type: 3, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
    ],
  },
  {
    name: "我的帳單", type: 1,
    description: "查詢你目前的待繳項目與最近的繳費紀錄",
  },
  {
    name: "發起繳費", type: 1,
    description: "（管理員）確認指定期別各方案金額並發出開繳通知",
    default_member_permissions: "32",
  },
  {
    name: "綁定", type: 1,
    description: "把你的 Discord 帳號綁定到名單上的成員",
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
