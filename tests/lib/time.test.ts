import { describe, expect, it } from "vitest";

import {
  ageHours,
  exponentialRecency,
  isIsoDateTime,
  shanghaiDateKey,
  toIsoString,
} from "../../src/lib/time.js";

describe("time helpers", () => {
  it("validates ISO date-time strings with an explicit timezone", () => {
    expect(isIsoDateTime("2026-07-18T10:30:00.000Z")).toBe(true);
    expect(isIsoDateTime("2026-07-18T18:30:00+08:00")).toBe(true);
    expect(isIsoDateTime("2026-02-30T10:30:00Z")).toBe(false);
    expect(isIsoDateTime("2026-07-18 10:30:00")).toBe(false);
    expect(isIsoDateTime("2026-07-18")).toBe(false);
  });

  it("converts supported date inputs to a canonical ISO string", () => {
    expect(toIsoString("2026-07-18T18:30:00+08:00")).toBe(
      "2026-07-18T10:30:00.000Z",
    );
    expect(toIsoString(new Date("2026-07-18T10:30:00.000Z"))).toBe(
      "2026-07-18T10:30:00.000Z",
    );
  });

  it("rejects invalid date inputs during conversion", () => {
    expect(() => toIsoString("not-a-date")).toThrow(/valid date/i);
    expect(() => toIsoString(new Date(Number.NaN))).toThrow(/valid date/i);
  });

  it("computes age in fractional hours", () => {
    expect(
      ageHours(
        "2026-07-18T04:15:00.000Z",
        new Date("2026-07-18T10:45:00.000Z"),
      ),
    ).toBe(6.5);
  });

  it("uses an exponential half-life and clamps future ages to full recency", () => {
    expect(exponentialRecency(0, 24)).toBe(1);
    expect(exponentialRecency(24, 24)).toBeCloseTo(0.5, 12);
    expect(exponentialRecency(48, 24)).toBeCloseTo(0.25, 12);
    expect(exponentialRecency(-2, 24)).toBe(1);
    expect(() => exponentialRecency(1, 0)).toThrow(/half-life/i);
  });

  it("creates Asia/Shanghai date keys without changing the process timezone", () => {
    const originalTimezone = process.env.TZ;

    expect(shanghaiDateKey("2026-07-18T15:59:59.000Z")).toBe("2026-07-18");
    expect(shanghaiDateKey("2026-07-18T16:00:00.000Z")).toBe("2026-07-19");
    expect(process.env.TZ).toBe(originalTimezone);
  });
});
