import { dailyBusinessEndHour } from "@superpm/shared";

export const businessTimeZone = resolveBusinessTimeZone();

function resolveBusinessTimeZone() {
  const configured = process.env.SUPERPM_BUSINESS_TZ?.trim();
  if (configured) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface BusinessParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function businessParts(
  date: Date,
  timeZone = businessTimeZone,
): BusinessParts {
  const values = new Map<string, number>();
  for (const part of zonedFormatter(timeZone).formatToParts(date))
    if (part.type !== "literal") values.set(part.type, Number(part.value));
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    // 部分引擎在午夜返回 24 时
    hour: (values.get("hour") ?? 0) % 24,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

/** 业务日期 YYYY-MM-DD（按业务时区，而不是 UTC 日期）。 */
export function businessDate(date: Date, timeZone = businessTimeZone) {
  const parts = businessParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function businessMonth(date: Date, timeZone = businessTimeZone) {
  return businessDate(date, timeZone).slice(0, 7);
}

function parseDatePart(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function parseTimePart(value: string) {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return { hour, minute, second };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = businessParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 把业务时区的本地日期时间转换为 UTC 时刻。 */
export function zonedDateTime(
  date: string,
  time: string,
  timeZone = businessTimeZone,
) {
  const { year, month, day } = parseDatePart(date);
  const { hour, minute, second } = parseTimePart(time);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  // 偏移量随夏令时变化，迭代收敛两次即可稳定
  for (let index = 0; index < 3; index += 1) {
    const next = target - timeZoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function businessDayStart(date: string, timeZone = businessTimeZone) {
  return zonedDateTime(date, "00:00:00", timeZone);
}

export function businessDayEnd(date: string, timeZone = businessTimeZone) {
  return zonedDateTime(date, `${pad(dailyBusinessEndHour)}:00:00`, timeZone);
}

export function nextBusinessDayStart(
  date: string,
  timeZone = businessTimeZone,
) {
  return businessDayStart(addDays(date, 1), timeZone);
}

export function addDays(date: string, amount: number) {
  const { year, month, day } = parseDatePart(date);
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function addMonths(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}`;
}

export function daysInMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function monthDates(month: string) {
  const total = daysInMonth(month);
  return Array.from(
    { length: total },
    (_, index) => `${month}-${pad(index + 1)}`,
  );
}

export function isSameBusinessDay(left: Date, right: Date) {
  return businessDate(left) === businessDate(right);
}
