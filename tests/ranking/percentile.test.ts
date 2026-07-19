import { describe, expect, it } from "vitest";

import { percentileRanks } from "../../src/ranking/percentile.js";

describe("percentileRanks", () => {
  it("uses an empirical percentile with stable tie handling", () => {
    expect(percentileRanks([0, 10, 20, 20])).toEqual([0.125, 0.375, 0.75, 0.75]);
  });

  it("uses a neutral percentile for lone, tied, and unavailable observations", () => {
    expect(percentileRanks([7])).toEqual([0.5]);
    expect(percentileRanks([4, 4])).toEqual([0.5, 0.5]);
    expect(percentileRanks([null, 10, 20])).toEqual([0.5, 0.25, 0.75]);
  });

  it("rejects negative, unsafe, or non-finite metrics", () => {
    expect(() => percentileRanks([-1])).toThrow(/metric/i);
    expect(() => percentileRanks([Number.NaN])).toThrow(/metric/i);
    expect(() => percentileRanks([Number.POSITIVE_INFINITY])).toThrow(/metric/i);
  });
});
