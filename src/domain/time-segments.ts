// 从 app/.../domain/TimeSegments.kt 逐行移植。一天中的时段：首页据此决定是否显示天气卡片
// （夜间改为在页头显示明日天气）。判定用 Europe/Oslo 本地时间，边界值全部取左闭右开。
import { osloParts } from "../util/time";

export type TimeSegment = "MORNING" | "DAY" | "EVENING" | "NIGHT";

export function resolveTimeSegment(now: Date): TimeSegment {
  const { hour, minute } = osloParts(now);
  const minutesOfDay = hour * 60 + minute;
  if (minutesOfDay < 5 * 60) return "NIGHT";
  if (minutesOfDay < 10 * 60) return "MORNING";
  if (minutesOfDay < 15 * 60) return "DAY";
  if (minutesOfDay < 21 * 60) return "EVENING";
  return "NIGHT";
}
