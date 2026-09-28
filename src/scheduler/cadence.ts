// 纯函数：给定任务名、当前时刻、设置与上下文，算出下一次应该运行的时刻。
// 严格对应 CONTRACT.md 第 5 节的间隔表。不做任何 I/O，方便用固定时刻做单元测试
// （尤其是夏令时切换日与跨午夜窗口）。
import type { Settings } from "../contract/settings";
import { type CommuteWindow, type LocalHm, resolveWindow, resolveWindowBounds } from "../domain/windows";
import { osloParts } from "../util/time";

export type JobName =
  | "train"
  | "bus"
  | "weather"
  | "traffic_outbound"
  | "traffic_return"
  | "football"
  | "notify"
  | "housekeeping";

/** 已知任务名，按契约第 5 节的顺序列出。 */
export const ALL_JOB_NAMES: readonly JobName[] = [
  "train",
  "bus",
  "weather",
  "traffic_outbound",
  "traffic_return",
  "football",
  "notify",
  "housekeeping",
] as const;

export interface CadenceCtx {
  /** weather 上次响应头里的 Expires（若有）；下一次不早于它。 */
  weatherExpiresAt?: Date;
  /** 下一场需要关注的比赛（P3 football 任务接入后才会传真实值）。 */
  football?: { kickoffAt: Date; endAt: Date } | null;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * 把 Europe/Oslo 本地挂钟时间 (y,m,d,hh,mm,ss) 转成 UTC 时刻（G3 修复 6）。
 *
 * Oslo 相对 UTC 的偏移只有两种取值：CET +1h（冬令时）与 CEST +2h（夏令时）。于是直接按
 * 「先试 +2h，再试 +1h」的顺序把两种偏移都减一遍，用 osloParts 回校哪一个真的能还原出
 * 目标挂钟时间：
 *   - 秋季切换当天 02:00–03:00 这类被走过两遍的本地时刻，两个候选都能回校成功，
 *     先试的 +2h（夏令时，对应更早的真实 UTC 时刻）就是「第一次出现」；
 *   - 春季切换当天 02:00–03:00 这类根本不存在的本地时刻，两个候选都回校不出目标值——
 *     这时按「切换前」的固定偏移 +1h 直接减，得到的实际 Oslo 本地时间会落在切换之后
 *     （例如 02:30 变成 03:30），这正是 Java `ZonedDateTime.of` 对空隙时刻的处理方式：
 *     顺延到切换后，不报错也不拒绝。
 */
export function osloLocalToUtc(y: number, m: number, d: number, hh: number, mm: number, ss = 0): Date {
  const targetUtcMs = Date.UTC(y, m - 1, d, hh, mm, ss);
  const CANDIDATE_OFFSET_HOURS = [2, 1]; // 先夏令时、后冬令时，保证重复时刻取第一次出现
  for (const offsetHours of CANDIDATE_OFFSET_HOURS) {
    const candidateMs = targetUtcMs - offsetHours * 3_600_000;
    const p = osloParts(new Date(candidateMs));
    if (p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm && p.second === ss) {
      return new Date(candidateMs);
    }
  }
  // 空隙时刻：两个候选都对不上，顺延到切换后。
  return new Date(targetUtcMs - 1 * 3_600_000);
}

/** 把 Oslo 本地日期往后推 deltaDays 天，返回新的 {year, month, day}（用 UTC 日期运算处理跨月/跨年，不受时区影响）。 */
function addOsloCalendarDays(p: { year: number; month: number; day: number }, deltaDays: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + deltaDays));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 严格晚于 now 的、下一次 Oslo 本地时间为 hm 的时刻。 */
function nextOsloTimeAfter(now: Date, hm: LocalHm): Date {
  const p = osloParts(now);
  let candidate = osloLocalToUtc(p.year, p.month, p.day, hm.hour, hm.minute, 0);
  if (candidate.getTime() <= now.getTime()) {
    const next = addOsloCalendarDays(p, 1);
    candidate = osloLocalToUtc(next.year, next.month, next.day, hm.hour, hm.minute, 0);
  }
  return candidate;
}

/** train：通勤窗口内 2 分钟，窗口外 15 分钟。 */
function nextTrain(now: Date, settings: Settings): Date {
  const win = resolveWindow(now, settings);
  return addMinutes(now, win === "OUTSIDE" ? 15 : 2);
}

/** bus：06:00–23:30 每 5 分钟，其余 30 分钟。 */
function nextBus(now: Date): Date {
  const p = osloParts(now);
  const mins = p.hour * 60 + p.minute;
  const active = mins >= 6 * 60 && mins < 23 * 60 + 30;
  return addMinutes(now, active ? 5 : 30);
}

/** weather：30 分钟，且不早于上次响应的 Expires。 */
function nextWeather(now: Date, ctx: CadenceCtx): Date {
  const base = addMinutes(now, 30);
  if (ctx.weatherExpiresAt && ctx.weatherExpiresAt.getTime() > base.getTime()) {
    return ctx.weatherExpiresAt;
  }
  return base;
}

/** traffic_outbound / traffic_return 共用：目标窗口内 5 分钟；窗口外等到下一个目标窗口开始。 */
function nextTraffic(now: Date, settings: Settings, target: Exclude<CommuteWindow, "OUTSIDE">): Date {
  const win = resolveWindow(now, settings);
  if (win === target) {
    return addMinutes(now, 5);
  }
  const bounds = resolveWindowBounds(settings);
  const start = target === "WORK" ? bounds.workStart : bounds.returnStart;
  return nextOsloTimeAfter(now, start);
}

/** football：默认 6 小时；开球前 90 分钟到终场之间每分钟。 */
function nextFootball(now: Date, ctx: CadenceCtx): Date {
  const match = ctx.football;
  if (match) {
    const activeFrom = addMinutes(match.kickoffAt, -90);
    if (now.getTime() >= activeFrom.getTime() && now.getTime() < match.endAt.getTime()) {
      return addMinutes(now, 1);
    }
  }
  return addMinutes(now, 6 * 60);
}

/** housekeeping：每天本地 03:30。 */
function nextHousekeeping(now: Date): Date {
  return nextOsloTimeAfter(now, { hour: 3, minute: 30 });
}

/** 按契约第 5 节的间隔表，算出任务 job 在 now 之后的下一次运行时刻（正常路径，不含失败退避）。 */
export function nextRunAt(job: JobName, now: Date, settings: Settings, ctx: CadenceCtx = {}): Date {
  switch (job) {
    case "train":
      return nextTrain(now, settings);
    case "bus":
      return nextBus(now);
    case "weather":
      return nextWeather(now, ctx);
    case "traffic_outbound":
      return nextTraffic(now, settings, "WORK");
    case "traffic_return":
      return nextTraffic(now, settings, "RETURN");
    case "football":
      return nextFootball(now, ctx);
    case "notify":
      return addMinutes(now, 1);
    case "housekeeping":
      return nextHousekeeping(now);
    default: {
      const _exhaustive: never = job;
      throw new Error(`未知任务：${String(_exhaustive)}`);
    }
  }
}

/** 失败退避序列：2、4、8、16、30、30...分钟（fail_count 从 1 起数，2^n 封顶 30）。 */
export function backoffMinutes(failCount: number): number {
  return Math.min(2 ** failCount, 30);
}

/**
 * 失败时的下一次运行时刻（G3 修复 4）：只按 `backoff(fail_count)` 走，不再与正常间隔取
 * min——旧版本会把退避跟「正常间隔」取更早者，导致 notify 这类间隔很短的任务失败了也
 * 几乎不退避，起不到保护作用。`job`/`ctx` 保留在签名里只是为了跟 `nextRunAt` 的调用形状
 * 一致，方便调用方不用区分成功/失败两条路径要传的参数。
 */
export function nextRunAtAfterFailure(
  _job: JobName,
  now: Date,
  _settings: Settings,
  failCount: number,
  _ctx: CadenceCtx = {},
): Date {
  return addMinutes(now, backoffMinutes(failCount));
}
