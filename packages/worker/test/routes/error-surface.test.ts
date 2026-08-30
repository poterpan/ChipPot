import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

/**
 * An unhandled error used to answer a bare "internal error" everywhere, so the only way to learn
 * what actually broke was to trawl Cloudflare logs — and a fork owner who did exactly that found
 * nothing. Detail now reaches the Access-gated admin surface, and ONLY that surface.
 */
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** The shape of the real incident: a missing column after an unapplied migration. */
const brokenDb = () => ({
  ...env,
  DB: { prepare() { throw new Error("D1_ERROR: no such column: event"); } },
} as unknown as typeof env);

const fetch500 = async (path: string) => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await worker.fetch(new Request(`https://x${path}`), brokenDb(), CTX);
  spy.mockRestore();
  return { status: res.status, body: (await res.json()) as { error: string } };
};

describe("500 detail is scoped to the admin surface", () => {
  /**
   * The /admin/* half cannot be exercised end-to-end here: requireAccess rejects with 403 before
   * any handler runs unless a real Access JWT is present, so a fault-injected route never reaches
   * the catch-all. What IS asserted is the routing predicate the branch depends on, plus the
   * member-facing half below — which is the side that carries the disclosure risk.
   */
  it("routes /admin/* to the detailed branch and everything else to the opaque one", () => {
    const detailed = (p: string) => new URL(`https://x${p}`).pathname.startsWith("/admin/");
    expect(detailed("/admin/workspace")).toBe(true);
    expect(detailed("/api/admin/workspace".slice(4))).toBe(true); // /api is stripped upstream
    expect(detailed("/upload/deadbeef")).toBe(false);
    expect(detailed("/interactions")).toBe(false);
    expect(detailed("/health")).toBe(false);
  });

  /**
   * The member page renders body.error straight onto the phone (web/src/api.ts), so leaking a SQL
   * string here would undo P0-6 (#45), which removed technical English from exactly that surface.
   */
  it("keeps the member upload route opaque", async () => {
    const { status, body } = await fetch500("/upload/deadbeef");
    expect(status).toBe(500);
    expect(body.error).toBe("internal error");
    expect(body.error).not.toContain("D1_ERROR");
  });
});
