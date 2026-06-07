import type { Env } from "./env";
import { Router } from "./router";
import {
  json, errorResponse, preflight, withHeaders, corsHeadersFor, type CorsOptions,
} from "./http";
import { handleUploadInfo, handleUpload } from "./routes/upload";
import { handleImage } from "./routes/images";
import { buildAdminRouter } from "./routes/admin";
import { handleInteractions } from "./routes/interactions";
import { requireAccess, AccessDenied } from "./middleware/access";
import { runDailyTasks } from "./core/scheduled";
import { discordNotifier } from "./adapters/discord/notify";

const publicRouter = new Router<Env>()
  .get("/upload/:token", handleUploadInfo)
  .post("/upload/:token", handleUpload);

// Admin API + the protected image stream, all under /admin/* (Access-gated below).
const adminRouter = buildAdminRouter().get("/admin/image", handleImage);

function corsOptions(env: Env): CorsOptions {
  const allowedOrigins = [env.WEB_ORIGIN, env.ADMIN_ORIGIN].filter(
    (o): o is string => Boolean(o)
  );
  return { allowedOrigins, allowMethods: "GET,POST,PATCH,DELETE,OPTIONS", allowHeaders: "content-type" };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(req.url);
    // admin.example.com/api/* routes to this worker; strip /api so the same routers match.
    if (url.pathname.startsWith("/api/")) {
      url = new URL(req.url);
      url.pathname = url.pathname.slice(4);
      req = new Request(url.toString(), req);
    }
    const cors = corsOptions(env);

    const pf = preflight(req, cors);
    if (pf) return pf;
    const corsHeaders = corsHeadersFor(req.headers.get("Origin"), cors);

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "chippot" });
      }

      // Discord interactions (server-to-server; signature-verified, no CORS).
      if (url.pathname === "/interactions") {
        if (req.method !== "POST") return errorResponse(405, "method not allowed");
        return handleInteractions(req, env, ctx);
      }

      const pub = await publicRouter.handle(req, env);
      if (pub) return withHeaders(pub, corsHeaders);

      if (url.pathname.startsWith("/admin/")) {
        let identity;
        try {
          identity = await requireAccess(req, env);
        } catch (e) {
          if (e instanceof AccessDenied) return withHeaders(errorResponse(403, "forbidden"), corsHeaders);
          throw e;
        }
        const adminRes = await adminRouter.handle(req, env, { identity });
        if (adminRes) return withHeaders(adminRes, corsHeaders);
      }

      return errorResponse(404, "not found");
    } catch (err) {
      console.error("unhandled error", err);
      return errorResponse(500, "internal error");
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDailyTasks(env, new Date(), discordNotifier)
        .then((s) => console.log("daily tasks", JSON.stringify(s)))
        .catch((e) => console.error("daily tasks failed", e))
    );
  },
} satisfies ExportedHandler<Env>;
