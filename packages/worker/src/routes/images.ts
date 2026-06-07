import type { Env } from "../env";
import type { RouteCtx } from "../router";
import { errorResponse } from "../http";

/**
 * GET /admin/image?key=<r2 key> — stream a payment screenshot from the private bucket.
 * Access-gated by the /admin/* wrapper. Only keys that are an actual payment proof are
 * served (so an authenticated admin can't enumerate arbitrary R2 paths). Never cached.
 */
export async function handleImage(
  _req: Request,
  env: Env,
  ctx: RouteCtx
): Promise<Response> {
  const key = ctx.url.searchParams.get("key");
  if (!key) return errorResponse(400, "key is required");

  if (!env.BUCKET) return errorResponse(404, "not found");

  const known = await env.DB
    .prepare("SELECT 1 AS ok FROM payments WHERE screenshot_key = ?")
    .bind(key)
    .first<{ ok: number }>();
  if (!known) return errorResponse(404, "not found");

  const obj = await env.BUCKET.get(key);
  if (!obj) return errorResponse(404, "not found");

  const headers = new Headers();
  headers.set("cache-control", "no-store");
  const ct = obj.httpMetadata?.contentType;
  if (ct) headers.set("content-type", ct);
  return new Response(obj.body, { headers });
}
