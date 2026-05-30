import { describe, expect, it } from "vitest";
import {
  nowUtcIso, taipeiDate, taipeiPeriod, taipeiDayOfMonth,
  periodStart, periodEnd, dueDate, daysBetween,
} from "../../src/core/time";

describe("time", () => {
  it("nowUtcIso returns UTC ISO with millis", () => {
    expect(nowUtcIso(new Date("2026-05-31T12:00:00.000Z"))).toBe("2026-05-31T12:00:00.000Z");
  });

  it("taipeiDate rolls to next day across UTC midnight (UTC+8)", () => {
    // 17:30 UTC = 01:30 next day in Taipei
    expect(taipeiDate(new Date("2026-05-31T17:30:00.000Z"))).toBe("2026-06-01");
    // 15:59 UTC = 23:59 same day in Taipei
    expect(taipeiDate(new Date("2026-05-31T15:59:00.000Z"))).toBe("2026-05-31");
  });

  it("taipeiPeriod / taipeiDayOfMonth cross year boundary", () => {
    const d = new Date("2026-12-31T16:30:00.000Z"); // Taipei 2027-01-01 00:30
    expect(taipeiPeriod(d)).toBe("2027-01");
    expect(taipeiDayOfMonth(d)).toBe(1);
  });

  it("periodStart / periodEnd handle month lengths and leap years", () => {
    expect(periodStart("2026-05")).toBe("2026-05-01");
    expect(periodEnd("2026-02")).toBe("2026-02-28");
    expect(periodEnd("2024-02")).toBe("2024-02-29");
    expect(periodEnd("2026-12")).toBe("2026-12-31");
  });

  it("dueDate pads billing_day", () => {
    expect(dueDate("2026-05", 5)).toBe("2026-05-05");
    expect(dueDate("2026-05", 28)).toBe("2026-05-28");
  });

  it("daysBetween counts whole days", () => {
    expect(daysBetween("2026-05-05", "2026-05-09")).toBe(4);
    expect(daysBetween("2026-05-09", "2026-05-05")).toBe(-4);
  });
});
