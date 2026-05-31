import type { Env } from "../env";
import type { RouteCtx } from "../router";
import { errorResponse, json } from "../http";
import { nowUtcIso } from "../core/time";
import { hashToken, findValidUploadToken } from "../core/tokens";
import { listActiveSubscriptions } from "../core/db";
import {
  submitProofWithToken, recordDeclaredWithToken, assertImageOk, extForContentType,
  InvalidImage, TokenUnusable, NoEligiblePayment,
} from "../core/storage";

/** GET /upload/:token — info for the web page (user, period, subscription choices). */
export async function handleUploadInfo(
  _req: Request,
  env: Env,
  ctx: RouteCtx
): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(404, "invalid or expired link", { valid: false });

  const user = await env.DB
    .prepare("SELECT display_name FROM users WHERE id = ?")
    .bind(tok.user_id)
    .first<{ display_name: string }>();

  const all = await listActiveSubscriptions(env.DB, tok.workspace_id, tok.user_id);
  const subscriptions = tok.subscription_id
    ? all.filter((s) => s.id === tok.subscription_id)
    : all;

  return json({
    valid: true,
    period: tok.period,
    user: { display_name: user?.display_name ?? "" },
    fixed_subscription_id: tok.subscription_id,
    subscriptions,
  });
}

/** POST /upload/:token — multipart screenshot submission. */
export async function handleUpload(
  req: Request,
  env: Env,
  ctx: RouteCtx
): Promise<Response> {
  const hash = await hashToken(ctx.params.token!);
  const tok = await findValidUploadToken(env.DB, hash, nowUtcIso());
  if (!tok) return errorResponse(410, "link is no longer valid", { code: "token" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse(400, "expected a multipart form");
  }

  // Screenshot OR note — at least one required (both optional).
  const entry = form.get("screenshot");
  const hasFile = entry !== null && typeof entry !== "string";
  const noteRaw = form.get("note");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;
  if (!hasFile && !note) {
    return errorResponse(400, "請至少附上截圖，或填寫備註");
  }

  // Resolve the subscription: bound by the token, else chosen by the client (validated).
  const subscriptionId = tok.subscription_id ?? Number(form.get("subscription_id") ?? NaN);
  if (!Number.isInteger(subscriptionId)) {
    return errorResponse(400, "subscription_id is required");
  }
  const sub = await env.DB
    .prepare(
      "SELECT id FROM subscriptions WHERE id = ? AND workspace_id = ? AND user_id = ? AND status = 'active'"
    )
    .bind(subscriptionId, tok.workspace_id, tok.user_id)
    .first<{ id: number }>();
  if (!sub) return errorResponse(400, "invalid subscription");

  const common = {
    tokenHash: hash,
    subscriptionId,
    workspaceId: tok.workspace_id,
    userId: tok.user_id,
    period: tok.period,
    source: "user_web",
    paymentNote: note,
  };

  try {
    if (!hasFile) {
      const res = await recordDeclaredWithToken(env, common);
      return json({ ok: true, payment_id: res.paymentId, has_proof: 0 });
    }
    const file = entry as unknown as Blob;
    const buf = await file.arrayBuffer();
    const contentType = file.type;
    try {
      assertImageOk(contentType, buf.byteLength);
    } catch (e) {
      if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" });
      throw e;
    }
    const res = await submitProofWithToken(env, {
      ...common,
      body: buf,
      ext: extForContentType(contentType),
      contentType,
    });
    return json({ ok: true, payment_id: res.paymentId, has_proof: 1 });
  } catch (e) {
    if (e instanceof TokenUnusable) return errorResponse(410, "link already used", { code: "token" });
    if (e instanceof NoEligiblePayment) {
      return errorResponse(409, "this period is already paid or finalized", { code: "payment" });
    }
    if (e instanceof InvalidImage) return errorResponse(400, e.message, { code: "image" });
    throw e;
  }
}
