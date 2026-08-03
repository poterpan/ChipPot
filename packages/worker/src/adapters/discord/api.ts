const API = "https://discord.com/api/v10";

/** Edit the original (deferred) interaction response via the interaction webhook token. */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  body: unknown
): Promise<boolean> {
  const res = await fetch(
    `${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  );
  return res.ok;
}

/**
 * Outcome of a create-message call. `ok` is the only thing that may be read as "Discord took it":
 * it is set solely by a 2xx. `id` is a bonus — a 2xx whose body we could not parse still counts as
 * delivered, so the two must stay separate (callers that persist a message id need both).
 */
export interface SentMessage {
  ok: boolean;
  id: string | null;
}

/**
 * Create a message in a channel (bot token). Never throws: a transport error is a failed send like
 * any other, and every caller is mid-way through a billing operation whose already-committed writes
 * must not be turned into a 500 by a Discord hiccup — they report `ok: false` instead.
 */
export async function createChannelMessage(
  botToken: string,
  channelId: string,
  body: unknown
): Promise<SentMessage> {
  let res: Response;
  try {
    res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("discord createChannelMessage failed", err);
    return { ok: false, id: null };
  }
  if (!res.ok) {
    console.error("discord createChannelMessage non-2xx", res.status);
    return { ok: false, id: null };
  }
  const msg = (await res.json().catch(() => null)) as { id?: string } | null;
  return { ok: true, id: msg?.id ?? null };
}

/** Edit an existing channel message (bot token). */
export async function editChannelMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  body: unknown
): Promise<boolean> {
  const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/** Overwrite a guild's application commands (bot token). */
export async function registerGuildCommands(
  botToken: string,
  applicationId: string,
  guildId: string,
  commands: unknown[]
): Promise<Response> {
  return fetch(`${API}/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: "PUT",
    headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
}
