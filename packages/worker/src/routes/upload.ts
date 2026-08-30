import type { Env } from "../env";
import type { RouteCtx } from "../router";
import { errorResponse, json } from "../http";
import { nowUtcIso } from "../core/time";
import { hashToken, findValidUploadToken } from "../core/tokens";
import { listSettleablePayments, listActiveChannelTags } from "../core/db";
import { isBillingOpened } from "../core/notify";
import {
  settleUserPeriod, assertImageOk, extForContentType,
  InvalidImage, TokenUnusable, NoEligiblePayment,
} from "../core/storage";

// Member-facing copy lives here, not in the SPA: this route is the only thing that knows WHY it
// said no, and any client (the upload page today, a Discord deep link tomorrow) needs the same
// sentence. The `code` field stays for programmatic handling.
const IMAGE_ERROR: Record<string, string> = {
  type: "只接受 PNG／JPG／WebP 圖片，請換一張截圖。",
  size: "截圖檔案太大（上限 10 MB），請壓縮後再試。",
  empty: "這個檔案是空的（0 KB），請重新選一張截圖。",
};
const imageError = (e: InvalidImage) => IMAGE_ERROR[e.reason] ?? IMAGE_ERROR.type!;

/** GET /upload/:token — info for the web page (user, period, subs, channel tags). */
export async function handleUploadInfo(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(404, "連結無效或已過期。", { valid: false });

  const user = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(tok.user_id).first<{ display_name: string }>();
  // ONE source of truth for 「你要繳多少」: the period's own bills (pending/rejected), exactly what
  // POST will settle. Plan pricing was the old source — it re-listed already-paid subscriptions and
  // ignored per-bill overrides, so the page's total disagreed with the Discord prompt (C6).
  const settleable = await listSettleablePayments(env.DB, tok.workspace_id, tok.user_id, tok.period);
  const channel_tags = await listActiveChannelTags(env.DB, tok.workspace_id);

  return json({
    valid: true,
    period: tok.period,
    user: { display_name: user?.display_name ?? "" },
    lines: settleable.map((p) => ({ payment_id: p.id, plan_name: p.plan_name, amount: p.amount })),
    channel_tags,
    proof_enabled: !!env.BUCKET,
  });
}

/** POST /upload/:token — settle all the user's period subs (screenshot/note/channel: ≥1). */
export async function handleUpload(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(410, "這個連結已失效或已經使用過，請向管理員索取新的連結。", { code: "token" });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return errorResponse(400, "表單格式不正確，請重新整理頁面再送出。"); }

  const entry = form.get("screenshot");
  const hasFile = entry !== null && typeof entry !== "string";
  const noteRaw = form.get("note");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;

  let declaredChannelTagId: number | null = null;
  const chanRaw = form.get("declared_channel_tag_id");
  if (typeof chanRaw === "string" && chanRaw.trim()) {
    const id = Number(chanRaw);
    const ok = await env.DB.prepare("SELECT 1 AS ok FROM channel_tags WHERE id = ? AND workspace_id = ? AND active = 1").bind(id, tok.workspace_id).first<{ ok: number }>();
    if (!ok) return errorResponse(400, "選擇的繳費渠道無效，請重新選擇。");
    declaredChannelTagId = id;
  }

  if (!hasFile && !note && declaredChannelTagId === null) {
    return errorResponse(400, "請至少附上截圖、填寫備註，或選擇渠道。");
  }

  let proof: { body: ArrayBuffer; ext: string; contentType: string } | null = null;
  if (hasFile) {
    const file = entry as unknown as Blob;
    const buf = await file.arrayBuffer();
    try { assertImageOk(file.type, buf.byteLength); }
    catch (e) { if (e instanceof InvalidImage) return errorResponse(400, imageError(e), { code: "image" }); throw e; }
    proof = { body: buf, ext: extForContentType(file.type), contentType: file.type };
  }

  // Same gate the Discord path enforces (adapters/discord/handler.ts): a one-time link must not
  // settle a period members cannot otherwise pay. createUploadLink mints a token for any period,
  // opened or not, so without this an admin-issued link would settle the cron-created bills of a
  // period that was never opened — or one that 收回此期開繳 has since closed.
  if (!(await isBillingOpened(env.DB, tok.workspace_id, tok.period))) {
    return errorResponse(409, `${tok.period} 的繳費尚未開放，待管理員發出開繳通知後即可繳費。`, { code: "payment" });
  }

  try {
    const r = await settleUserPeriod(env, {
      workspaceId: tok.workspace_id, userId: tok.user_id, period: tok.period,
      source: "user_web", tokenHash: hash, declaredChannelTagId, paymentNote: note, proof,
    });
    return json({ ok: true, paid_count: r.paidCount, total_amount: r.totalAmount, has_proof: r.screenshotKey ? 1 : 0 });
  } catch (e) {
    if (e instanceof TokenUnusable) return errorResponse(410, "這個連結已經使用過了，請向管理員索取新的連結。", { code: "token" });
    if (e instanceof NoEligiblePayment) return errorResponse(409, "這一期已經登記過繳費了，不需要重複送出。", { code: "payment" });
    if (e instanceof InvalidImage) return errorResponse(400, imageError(e), { code: "image" });
    throw e;
  }
}
