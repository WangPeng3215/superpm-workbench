const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dateUtc(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function dateParts(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return {
    year,
    month,
    day,
    yearLabel: `${year}年`,
    monthDayLabel: `${month}月${day}日`,
    weekdayLabel: weekdayNames[new Date(dateUtc(date)).getUTCDay()],
  };
}

export function todayLabel(date: string) {
  return `${dateParts(date).monthDayLabel} ${dateParts(date).weekdayLabel}`;
}

export function shiftDate(date: string, days: number) {
  const next = new Date(dateUtc(date) + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

export function monthOf(date: string) {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number) {
  const [year, value] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, value - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
}

export function monthLabel(month: string) {
  const [year, value] = month.split("-").map(Number);
  return `${year}年${value}月`;
}

/** 以周一为起始的 6×7 日历格，包含相邻月份的日期。 */
export function monthCells(month: string) {
  const [year, value] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, value - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = Date.UTC(year, value - 1, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { date, inMonth: date.slice(0, 7) === month };
  });
}

export function formatDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  if (totalMinutes === 0) return seconds > 0 ? "不足 1 分钟" : "0 分钟";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} 分钟`;
  if (!minutes) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}

export function formatHours(seconds: number) {
  return `${(Math.max(0, seconds) / 3600).toFixed(1)} 小时`;
}

export function formatTimer(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const rest = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

export function formatEstimate(minutes: number) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

function zoneParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const values: Record<string, number> = {};
  for (const part of parts)
    if (part.type !== "literal") values[part.type] = Number(part.value);
  return values;
}

function zoneOffsetMs(instant: number, timeZone: string) {
  const parts = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** 把业务时区下看到的墙上时间转换为 ISO UTC 时刻。 */
export function wallTimeToIso(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const next = wallAsUtc - zoneOffsetMs(instant, timeZone);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant).toISOString();
}

export function timeValue(iso: string, timeZone: string) {
  const parts = zoneParts(new Date(iso).getTime(), timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function clockValue(iso: string, timeZone: string) {
  return timeValue(iso, timeZone);
}

export function dateValue(iso: string, timeZone: string) {
  const parts = zoneParts(new Date(iso).getTime(), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function monthDateRange(month: string) {
  const [year, value] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, value - 1, 1))
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
  return { start, end };
}
