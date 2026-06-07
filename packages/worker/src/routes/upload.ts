import type { Env } from "../env";
import type { RouteCtx } from "../router";
import { errorResponse, json } from "../http";
import { nowUtcIso } from "../core/time";
import { hashToken, findValidUploadToken } from "../core/tokens";
import { listActiveSubscriptions, listActiveChannelTags } from "../core/db";
import {
  settleUserPeriod, assertImageOk, extForContentType,
  InvalidImage, TokenUnusable, NoEligiblePayment,
} from "../core/storage";

/** GET /upload/:token — info for the web page (user, period, subs, channel tags). */
export async function handleUploadInfo(_req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(404, "invalid or expired link", { valid: false });

  const user = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(tok.user_id).first<{ display_name: string }>();
  const subscriptions = await listActiveSubscriptions(env.DB, tok.workspace_id, tok.user_id);
  const channel_tags = await listActiveChannelTags(env.DB, tok.workspace_id);

  return json({
    valid: true,
    period: tok.period,
    user: { display_name: user?.display_name ?? "" },
    subscriptions,
    channel_tags,
    proof_enabled: !!env.BUCKET,
  });
}

/** POST /upload/:token — settle all the user's period subs (screenshot/note/channel: ≥1). */
export async function handleUpload(req: Request, env: Env, ctx: RouteCtx): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(410, "link is no longer valid", { code: "token" });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return errorResponse(400, "expected a multipart form"); }

  const entry = form.get("screenshot");
  const hasFile = entry !== null && typeof entry !== "string";
  const noteRaw = form.get("note");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;

  let declaredChannelTagId: number | null = null;
  const chanRaw = form.get("declared_channel_tag_id");
  if (typeof chanRaw === "string" && chanRaw.trim()) {
    const id = Number(chanRaw);
    const ok = await env.DB.prepare("SELECT 1 AS ok FROM channel_tags WHERE id = ? AND workspace_id = ? AND active = 1").bind(id, tok.workspace_id).first<{ ok: number }>();
    if (!ok) return errorResponse(400, "invalid channel");
    declaredChannelTagId = id;
  }

  if (!hasFile && !note && declaredChannelTagId === null) {
    return errorResponse(400, "請至少附上截圖、填寫備註，或選擇渠道");
  }

  let proof: { body: ArrayBuffer; ext: string; contentType: string } | null = null;
  if (hasFile) {
    const file = entry as unknown as Blob;
    const buf = await file.arrayBuffer();
    try { assertImageOk(file.type, buf.byteLength); }
    catch (e) { if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" }); throw e; }
    proof = { body: buf, ext: extForContentType(file.type), contentType: file.type };
  }

  try {
    const r = await settleUserPeriod(env, {
      workspaceId: tok.workspace_id, userId: tok.user_id, period: tok.period,
      source: "user_web", tokenHash: hash, declaredChannelTagId, paymentNote: note, proof,
    });
    return json({ ok: true, paid_count: r.paidCount, total_amount: r.totalAmount, has_proof: r.screenshotKey ? 1 : 0 });
  } catch (e) {
    if (e instanceof TokenUnusable) return errorResponse(410, "link already used", { code: "token" });
    if (e instanceof NoEligiblePayment) return errorResponse(409, "this period is already paid or finalized", { code: "payment" });
    if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" });
    throw e;
  }
}
