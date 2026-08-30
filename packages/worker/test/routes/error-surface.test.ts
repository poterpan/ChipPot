import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

/**
 * An unhandled error used to answer a bare "internal error", so the only way to learn what actually
 * broke was to go trawling Cloudflare logs — and a fork owner who did exactly that reported finding
 * nothing. The admin API sits behind Cloudflare Access, so the audience for these messages is the
 * operator, not the public internet: say what went wrong.
 */
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("500 responses name the failure", () => {
  it("returns the error's message instead of a bare 'internal error'", async () => {
    // Fault-inject the DB binding: any admin route that touches D1 then throws, which is exactly
    // the shape of the real incident (a missing column after an unapplied migration).
    const broken = {
      ...env,
      DB: { prepare() { throw new Error("D1_ERROR: no such column: event"); } },
    } as unknown as typeof env;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(new Request("https://x/upload/deadbeef"), broken, CTX);
    spy.mockRestore();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no such column: event");  // the operator can act on this
    expect(body.error).not.toBe("internal error");
});
});
