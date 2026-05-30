export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(
  status: number,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return json({ error: message, ...extra }, { status });
}

export interface CorsOptions {
  allowedOrigins: string[];
  allowMethods?: string;
  allowHeaders?: string;
}

/** CORS headers for an allowed origin; empty object (no CORS) otherwise. */
export function corsHeadersFor(
  origin: string | null,
  opts: CorsOptions
): Record<string, string> {
  if (!origin || !opts.allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": opts.allowMethods ?? "GET,POST,OPTIONS",
    "access-control-allow-headers": opts.allowHeaders ?? "content-type",
    vary: "Origin",
  };
}

/** Returns a 204 preflight response for OPTIONS requests, else null. */
export function preflight(req: Request, opts: CorsOptions): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, {
    status: 204,
    headers: corsHeadersFor(req.headers.get("Origin"), opts),
  });
}

/** Return a copy of `res` with extra headers set (e.g. CORS, cache-control). */
export function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
