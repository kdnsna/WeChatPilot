export type DateInput = Date | number | string;

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function validDate(value: DateInput): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
        ? isIsoDateTime(value)
          ? new Date(value)
          : new Date(Number.NaN)
        : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Expected a valid date with an explicit timezone");
  }
  return date;
}

export function toIsoString(value: DateInput): string {
  return validDate(value).toISOString();
}

export function ageHours(
  publishedAt: DateInput,
  now: DateInput = new Date(),
): number {
  return (validDate(now).getTime() - validDate(publishedAt).getTime()) / 3_600_000;
}

export function exponentialRecency(
  ageInHours: number,
  halfLifeHours = 24,
): number {
  if (!Number.isFinite(ageInHours)) {
    throw new RangeError("Age must be a finite number of hours");
  }
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) {
    throw new RangeError("Recency half-life must be a positive number of hours");
  }
  return Math.pow(0.5, Math.max(0, ageInHours) / halfLifeHours);
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDateKey(value: DateInput): string {
  const parts = shanghaiDateFormatter.formatToParts(validDate(value));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError("Unable to create an Asia/Shanghai date key");
  }
  return `${year}-${month}-${day}`;
}
