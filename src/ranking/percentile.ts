function requireMetric(value: number): number {
  if (
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER ||
    value < 0
  ) {
    throw new RangeError("metric values must be finite non-negative safe numbers");
  }
  return value;
}

/**
 * Midrank empirical percentile within one source family. Null means the
 * upstream metric is unavailable and receives a neutral 0.5; real zero values
 * remain observations. Ties receive the same midpoint rank.
 */
export function percentileRanks(
  values: readonly (number | null)[],
): readonly number[] {
  const available = values.flatMap((value) =>
    value === null ? [] : [requireMetric(value)],
  );
  if (values.length === 0) {
    return [];
  }
  if (available.length === 0) {
    return values.map(() => 0.5);
  }

  return values.map((value) => {
    if (value === null) {
      return 0.5;
    }
    const checked = requireMetric(value);
    const less = available.filter((candidate) => candidate < checked).length;
    const equal = available.filter((candidate) => candidate === checked).length;
    return (less + equal / 2) / available.length;
  });
}
