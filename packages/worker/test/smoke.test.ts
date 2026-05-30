import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("binds D1 and R2", () => {
    expect(env.DB).toBeDefined();
    expect(env.BUCKET).toBeDefined();
  });
});
