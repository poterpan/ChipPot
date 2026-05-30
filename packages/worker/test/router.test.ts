import { describe, expect, it } from "vitest";
import { Router } from "../src/router";
import { json, errorResponse, corsHeadersFor, preflight, withHeaders } from "../src/http";

describe("Router", () => {
  it("matches static paths and method", async () => {
    const r = new Router<unknown>();
    r.get("/admin/ping", () => json({ ok: true }));
    const res = await r.handle(new Request("https://x/admin/ping"), {});
    expect(res).not.toBeNull();
    expect(await res!.json()).toEqual({ ok: true });
  });

  it("extracts path params", async () => {
    const r = new Router<unknown>();
    r.get("/admin/users/:id", (_req, _env, ctx) => json({ id: ctx.params.id }));
    const res = await r.handle(new Request("https://x/admin/users/42"), {});
    expect(await res!.json()).toEqual({ id: "42" });
  });

  it("returns null when nothing matches (path or method)", async () => {
    const r = new Router<unknown>();
    r.get("/a", () => json({}));
    expect(await r.handle(new Request("https://x/b"), {})).toBeNull();
    expect(await r.handle(new Request("https://x/a", { method: "POST" }), {})).toBeNull();
  });
});

describe("http helpers", () => {
  it("json sets content-type and status", async () => {
    const res = json({ a: 1 }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("errorResponse returns an error body + status", async () => {
    const res = errorResponse(400, "bad", { code: "X" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad", code: "X" });
  });

  it("corsHeadersFor only allows listed origins", () => {
    const opts = { allowedOrigins: ["https://ok.pages.dev"] };
    expect(corsHeadersFor("https://ok.pages.dev", opts)["access-control-allow-origin"]).toBe("https://ok.pages.dev");
    expect(corsHeadersFor("https://evil.com", opts)["access-control-allow-origin"]).toBeUndefined();
  });

  it("preflight answers OPTIONS for allowed origin", () => {
    const res = preflight(
      new Request("https://x", { method: "OPTIONS", headers: { Origin: "https://ok.pages.dev" } }),
      { allowedOrigins: ["https://ok.pages.dev"] }
    );
    expect(res?.status).toBe(204);
    expect(res?.headers.get("access-control-allow-origin")).toBe("https://ok.pages.dev");
  });

  it("withHeaders merges headers onto a response", () => {
    const res = withHeaders(json({}), { "cache-control": "no-store" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
