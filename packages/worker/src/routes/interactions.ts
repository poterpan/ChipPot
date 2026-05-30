import type { Env } from "../env";
import { json } from "../http";
import { verifyDiscordRequest } from "../adapters/discord/verify";

// Discord interaction + response type numbers we use.
const TYPE_PING = 1;
const RESP_PONG = 1;
const RESP_MESSAGE = 4;
const FLAG_EPHEMERAL = 64;

/**
 * Discord Interactions endpoint. Verifies the Ed25519 signature, answers the PING
 * handshake, and (until Phase 4 Task 2) returns an ephemeral placeholder for commands.
 * Reads the raw body itself because the signature covers `timestamp + rawBody`.
 */
export async function handleInteractions(req: Request, env: Env): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response("interactions not configured", { status: 503 });
  }
  const rawBody = await req.text();
  const valid = await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, req, rawBody);
  if (!valid) return new Response("invalid request signature", { status: 401 });

  let interaction: { type?: number };
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (interaction.type === TYPE_PING) {
    return json({ type: RESP_PONG });
  }

  // Command/component/autocomplete handling lands in Phase 4 Task 2.
  return json({
    type: RESP_MESSAGE,
    data: { content: "此功能尚未啟用，請稍後再試。", flags: FLAG_EPHEMERAL },
  });
}
