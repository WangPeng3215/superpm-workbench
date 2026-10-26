import type { MeetingType } from "@superpm/shared";

export const meetingTypeTone: Record<MeetingType, string> = {
  weekly: "tone-blue",
  group: "tone-teal",
  requirement: "tone-purple",
  training: "tone-amber",
};

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (value: number) => String(value).padStart(2, "0");

export interface MeetingTimeParts {
  date: string;
  weekday: string;
  time: string;
}

export function meetingTimeParts(value: string): MeetingTimeParts {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return { date: value, weekday: "", time: "" };
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    weekday: weekdays[date.getDay()],
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

export function formatMeetingTime(value: string): string {
  const parts = meetingTimeParts(value);
  return [parts.date, parts.weekday, parts.time].filter(Boolean).join(" ");
}

// 新建会议默认当前本地时间，精确到分钟
export function defaultMeetingTime(): Date {
  const now = new Date();
  now.setSeconds(0, 0);
  return now;
}
