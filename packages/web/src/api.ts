const API =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "https://chippot.poterpan.workers.dev";

export interface SubscriptionChoice {
  id: number;
  plan_name: string;
  amount: number;
}
export interface TokenInfo {
  valid: boolean;
  period?: string;
  user?: { display_name: string };
  fixed_subscription_id?: number | null;
  subscriptions?: SubscriptionChoice[];
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

export async function uploadProof(
  token: string,
  blob: Blob,
  subscriptionId: number | null,
  note: string
): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("screenshot", new File([blob], "proof.jpg", { type: "image/jpeg" }));
  if (subscriptionId != null) fd.append("subscription_id", String(subscriptionId));
  if (note.trim()) fd.append("note", note.trim());
  try {
    const res = await fetch(`${API}/upload/${token}`, { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? `錯誤 ${res.status}` };
  } catch {
    return { ok: false, error: "連線失敗，請稍後再試" };
  }
}
