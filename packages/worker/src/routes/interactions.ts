import type { Env } from "../env";
import { json } from "../http";
import { verifyDiscordRequest } from "../adapters/discord/verify";
import { routeInteraction, type DiscordInteraction } from "../adapters/discord/handler";
import { IT_PING, RT_PONG } from "../adapters/discord/commands";

/**
 * Discord Interactions endpoint. Verifies the Ed25519 signature, answers the PING
 * handshake, then dispatches to the Discord adapter. Reads the raw body itself because
 * the signature covers `timestamp + rawBody`.
 */
export async function handleInteractions(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response("interactions not configured", { status: 503 });
  }
  const rawBody = await req.text();
  const valid = await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, req, rawBody);
  if (!valid) return new Response("invalid request signature", { status: 401 });

  // Replay protection: the signature covers the timestamp, so a stale (replayed)
  // request is a valid signature over an old time. Reject if outside a 5-min window.
  const ts = Number(req.headers.get("X-Signature-Timestamp"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return new Response("stale request", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (interaction.type === IT_PING) return json({ type: RT_PONG });
  return routeInteraction(interaction, env, ctx);
}
