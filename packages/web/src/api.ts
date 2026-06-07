const API = import.meta.env.VITE_API_BASE as string | undefined;
if (!API) {
  // Fail loud instead of silently calling someone else's backend: a fork that forgot to set
  // VITE_API_BASE at build time would otherwise post payments to the upstream worker.
  throw new Error(
    "VITE_API_BASE is not set. Build the web app with it pointing at your worker, e.g. " +
      "VITE_API_BASE=https://chippot.<your-subdomain>.workers.dev pnpm --filter @chippot/web build"
  );
}

export interface SubscriptionChoice {
  id: number;
  plan_name: string;
  amount: number;
}
export interface ChannelTag {
  id: number;
  name: string;
}
export interface TokenInfo {
  valid: boolean;
  period?: string;
  user?: { display_name: string };
  subscriptions?: SubscriptionChoice[];
  channel_tags?: ChannelTag[];
  proof_enabled?: boolean;
}

export async function fetchTokenInfo(token: string): Promise<TokenInfo> {
  try {
    const res = await fetch(`${API}/upload/${token}`);
    if (!res.ok) return { valid: false };
    return (await res.json()) as TokenInfo;
  } catch {
    return { valid: false };
  }
}

export interface UploadResult {
  ok: boolean;
  error?: string;
}

/** Settle all of the user's period subscriptions in one submit. */
export async function submitPayment(
  token: string,
  blob: Blob | null,
  channelTagId: number | null,
  note: string
): Promise<UploadResult> {
  const fd = new FormData();
  if (blob) fd.append("screenshot", new File([blob], "proof.jpg", { type: "image/jpeg" }));
  if (channelTagId != null) fd.append("declared_channel_tag_id", String(channelTagId));
  if (note.trim()) fd.append("note", note.trim());
  try {
    const res = await fetch(`${API}/upload/${token}`, { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? `錯誤 ${res.status}` };
  } catch {
    return { ok: false, error: "連線失敗，請稍後再試" };
  }
}
