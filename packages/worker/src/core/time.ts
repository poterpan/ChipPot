const TZ = "Asia/Taipei";

/** UTC ISO 8601 with milliseconds, e.g. 2026-05-30T12:34:56.000Z */
export function nowUtcIso(d: Date = new Date()): string {
  return d.toISOString();
}

function taipeiParts(d: Date): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** YYYY-MM-DD in Asia/Taipei for the given instant. */
export function taipeiDate(d: Date = new Date()): string {
  const { y, m, d: day } = taipeiParts(d);
  return `${y}-${m}-${day}`;
}

/** YYYY-MM in Asia/Taipei. */
export function taipeiPeriod(d: Date = new Date()): string {
  return taipeiDate(d).slice(0, 7);
}

/** Day-of-month (1-31) in Asia/Taipei. */
export function taipeiDayOfMonth(d: Date = new Date()): number {
  return Number(taipeiDate(d).slice(8, 10));
}

/** First day of a YYYY-MM period. */
export function periodStart(period: string): string {
  return `${period}-01`;
}

/** Last day of a YYYY-MM period (handles 28/29/30/31). */
export function periodEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // day 0 of next month
  return `${period}-${String(last).padStart(2, "0")}`;
}

/** Due date = billing_day within the period. billing_day is constrained 1..28. */
export function dueDate(period: string, billingDay: number): string {
  return `${period}-${String(billingDay).padStart(2, "0")}`;
}

/**
 * The period currently being collected, given the billing day: on or after the billing day →
 * the current month; before it → the previous month (we're still collecting it). This is what
 * member self-pay and the dashboard default to. Asia/Taipei business date.
 */
export function periodForBillingDay(billingDay: number, d: Date = new Date()): string {
  const iso = taipeiDate(d); // YYYY-MM-DD
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (day >= billingDay) return `${y}-${String(m).padStart(2, "0")}`;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/**
 * The period an admin is about to open ("發起繳費" default): on or before the billing day →
 * the current month; after it → next month. This lets the admin pre-open next month near
 * month-end. Asia/Taipei business date.
 */
export function nextBillingPeriod(billingDay: number, d: Date = new Date()): string {
  const iso = taipeiDate(d); // YYYY-MM-DD
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (day <= billingDay) return `${y}-${String(m).padStart(2, "0")}`;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Whole days from fromDate to toDate (both YYYY-MM-DD); negative if toDate earlier. */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
