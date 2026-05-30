export interface RouteCtx {
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler<E> = (
  req: Request,
  env: E,
  ctx: RouteCtx
) => Promise<Response> | Response;

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchSegments(
  pattern: string[],
  path: string[]
): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const pat = pattern[i]!;
    const seg = path[i]!;
    if (pat.startsWith(":")) params[pat.slice(1)] = decodeURIComponent(seg);
    else if (pat !== seg) return null;
  }
  return params;
}

/** Tiny method+path router with `:param` segments. Returns null when nothing matches. */
export class Router<E> {
  private routes: { method: string; segs: string[]; handler: RouteHandler<E> }[] = [];

  add(method: string, pattern: string, handler: RouteHandler<E>): this {
    this.routes.push({ method: method.toUpperCase(), segs: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler<E>): this { return this.add("GET", pattern, handler); }
  post(pattern: string, handler: RouteHandler<E>): this { return this.add("POST", pattern, handler); }
  put(pattern: string, handler: RouteHandler<E>): this { return this.add("PUT", pattern, handler); }
  patch(pattern: string, handler: RouteHandler<E>): this { return this.add("PATCH", pattern, handler); }
  delete(pattern: string, handler: RouteHandler<E>): this { return this.add("DELETE", pattern, handler); }

  async handle(req: Request, env: E): Promise<Response | null> {
    const url = new URL(req.url);
    const pathSegs = split(url.pathname);
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchSegments(route.segs, pathSegs);
      if (params) return route.handler(req, env, { params, url });
    }
    return null;
  }
}
