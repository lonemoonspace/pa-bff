// notify 任务的输入选择：把「有效」快照挑出来喂给四个策略的 evaluate（CONTRACT.md 第
// 6.2 节）。纯函数，不碰 D1——调用方（jobs/notify.ts）负责用 snapshot.getMany 读快照。
//
// 「有效」的通用定义（6.2 节开头那段）：state = ok、data 非空且能被对应 schema 解析、
// now − fetchedAt 不超过时效（fetchedAt 晚于 now 也算有效，即允许时钟误差把它当成
// 「刚刚」）。stale / idle / not_configured / 缺失 / 过期都视为无效。
import {
  FootballStatusSchema,
  TrafficStatusSchema,
  TrainStatusSchema,
  WeatherStatusSchema,
  type FootballStatus,
  type TrafficStatus,
  type TrainStatus,
  type WeatherStatus,
} from "../contract/dashboard";
import type { Settings } from "../contract/settings";
import { type CommuteWindow, resolveWindow, resolveWindowBounds } from "../domain/windows";
import { osloLocalToUtc } from "../scheduler/cadence";
import type { SnapshotEnvelope } from "../snapshot/store";
import { osloParts } from "../util/time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const COMMUTE_MAX_AGE_MS = 5 * MINUTE_MS;
const MORNING_WEATHER_MAX_AGE_MS = 120 * MINUTE_MS;
const MORNING_TRAIN_MAX_AGE_MS = 5 * MINUTE_MS;
const MORNING_TRAFFIC_MAX_AGE_MS = 10 * MINUTE_MS;
const FOOTBALL_MAX_AGE_MS = 7 * HOUR_MS;

/** 早间简报的宽限期：当前 WORK 窗口开始后 10 分钟内（严格小于，第 10 分钟整已经过了宽限）。 */
const MORNING_GRACE_MS = 10 * MINUTE_MS;

/** notify 任务需要用到的四份快照（configKey 已由调用方按 configKeysFor 算好并读取）。 */
export interface NotifySnapshots {
  train: SnapshotEnvelope | null;
  weather: SnapshotEnvelope | null;
  traffic_outbound: SnapshotEnvelope | null;
  football: SnapshotEnvelope | null;
}

export type MorningInputs =
  | { weather: WeatherStatus | null; train: TrainStatus | null; traffic: TrafficStatus | null }
  | "skip"
  | "defer";

export interface NotifyInputs {
  commute: TrainStatus | null;
  morning: MorningInputs;
  football: FootballStatus | null;
}

function isFresh(fetchedAt: string | null, now: Date, maxAgeMs: number): boolean {
  if (fetchedAt === null) return false;
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedMs)) return false;
  // fetchedAt 晚于 now 时 (now - fetchedMs) 为负数，天然 <= maxAgeMs，视为有效。
  return now.getTime() - fetchedMs <= maxAgeMs;
}

/** 通用有效性：state=ok、data 非空、能被 schema 解析、未超时效。 */
function validData<T>(envelope: SnapshotEnvelope | null, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, now: Date, maxAgeMs: number): T | null {
  if (!envelope) return null;
  if (envelope.state !== "ok") return null;
  if (envelope.data === null || envelope.data === undefined) return null;
  if (!isFresh(envelope.fetchedAt, now, maxAgeMs)) return null;
  const parsed = schema.safeParse(envelope.data);
  return parsed.success && parsed.data !== undefined ? parsed.data : null;
}

/**
 * train 快照的有效性比通用规则多一条：生成快照时的窗口必须与 requiredWindow 相同
 * （commute 传当前窗口本身；morning 恒传 "WORK"，因为 morning 只在 WORK 窗口评估）。
 */
function validTrain(
  envelope: SnapshotEnvelope | null,
  settings: Settings,
  now: Date,
  maxAgeMs: number,
  requiredWindow: CommuteWindow,
): TrainStatus | null {
  if (!envelope) return null;
  if (envelope.state !== "ok") return null;
  if (envelope.data === null || envelope.data === undefined) return null;
  if (envelope.fetchedAt === null) return null;
  if (!isFresh(envelope.fetchedAt, now, maxAgeMs)) return null;
  const fetchedMs = Date.parse(envelope.fetchedAt);
  if (Number.isNaN(fetchedMs)) return null;
  if (resolveWindow(new Date(fetchedMs), settings) !== requiredWindow) return null;
  const parsed = TrainStatusSchema.safeParse(envelope.data);
  return parsed.success ? parsed.data : null;
}

/** 把 Oslo 本地日期往后（deltaDays 可为负）推若干天，用 UTC 日期运算，不受时区影响。 */
function addOsloCalendarDays(p: { year: number; month: number; day: number }, deltaDays: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + deltaDays));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * 当前 WORK 窗口开始时刻（UTC）：按 now 所在 Oslo 本地日期算出的 workStart 若晚于 now，
 * 说明这是一个跨午夜窗口、真正的开始时刻落在前一天——取前一天的 workStart（CONTRACT.md
 * 6.2 节「跨午夜窗口的开始时刻取前一天」）。
 */
function workWindowStartUtc(now: Date, settings: Settings): Date {
  const bounds = resolveWindowBounds(settings);
  const p = osloParts(now);
  const todayStart = osloLocalToUtc(p.year, p.month, p.day, bounds.workStart.hour, bounds.workStart.minute, 0);
  if (todayStart.getTime() <= now.getTime()) return todayStart;
  const prev = addOsloCalendarDays(p, -1);
  return osloLocalToUtc(prev.year, prev.month, prev.day, bounds.workStart.hour, bounds.workStart.minute, 0);
}

/**
 * 挑出四个策略各自需要的输入（不含 ticket——它「只看设置」，调用方直接把 settings 传给
 * ticket.evaluate，不需要经过这里）。
 */
export function selectInputs(snapshots: NotifySnapshots, settings: Settings, now: Date): NotifyInputs {
  const currentWindow = resolveWindow(now, settings);

  // commute_disruption：train 有效 + 生成快照时的窗口与当前窗口相同且不是 OUTSIDE。
  const commute =
    currentWindow === "OUTSIDE" ? null : validTrain(snapshots.train, settings, now, COMMUTE_MAX_AGE_MS, currentWindow);

  // football：与窗口无关，只看时效。
  const football = validData<FootballStatus>(snapshots.football, FootballStatusSchema, now, FOOTBALL_MAX_AGE_MS);

  const morning = selectMorningInputs(snapshots, settings, now, currentWindow);

  return { commute, morning, football };
}

function selectMorningInputs(
  snapshots: NotifySnapshots,
  settings: Settings,
  now: Date,
  currentWindow: CommuteWindow,
): MorningInputs {
  if (currentWindow !== "WORK") return "skip";

  const weather = validData<WeatherStatus>(snapshots.weather, WeatherStatusSchema, now, MORNING_WEATHER_MAX_AGE_MS);
  const traffic = validData<TrafficStatus>(
    snapshots.traffic_outbound,
    TrafficStatusSchema,
    now,
    MORNING_TRAFFIC_MAX_AGE_MS,
  );
  const train = validTrain(snapshots.train, settings, now, MORNING_TRAIN_MAX_AGE_MS, "WORK");

  const windowStart = workWindowStartUtc(now, settings);
  const inGrace = now.getTime() - windowStart.getTime() < MORNING_GRACE_MS;

  if (inGrace) {
    // 「应有」的来源：[gate] P9 起 train 也可能 not_configured（车站未选择），不再总是
    // 应有；三个来源都按「快照存在且 state ≠ not_configured」判定是否「应有」
    // （CONTRACT 第 6.2 节）。
    const weatherRequired = snapshots.weather !== null && snapshots.weather.state !== "not_configured";
    const trafficRequired = snapshots.traffic_outbound !== null && snapshots.traffic_outbound.state !== "not_configured";
    const trainRequired = snapshots.train !== null && snapshots.train.state !== "not_configured";
    const missingRequired =
      (trainRequired && train === null) || (weatherRequired && weather === null) || (trafficRequired && traffic === null);
    if (missingRequired) return "defer";
  }

  return { weather, train, traffic };
}

/** 四类状态的规范 JSON（键序固定、数组升序），供 CONTRACT.md 6.3 节「相同则不写」比较用。 */
export function serializeState(policy: "commute_disruption", state: { fingerprint: string | null }): string;
export function serializeState(policy: "morning_brief", state: { lastSentDate: string | null }): string;
export function serializeState(
  policy: "football",
  state: { kickoffNotifiedIds: string[]; finishedNotifiedIds: string[] },
): string;
export function serializeState(policy: "ticket", state: { keys: string[] }): string;
export function serializeState(policy: string, state: Record<string, unknown>): string {
  switch (policy) {
    case "commute_disruption":
      return JSON.stringify({ fingerprint: (state as { fingerprint: string | null }).fingerprint });
    case "morning_brief":
      return JSON.stringify({ lastSentDate: (state as { lastSentDate: string | null }).lastSentDate });
    case "football": {
      const s = state as { kickoffNotifiedIds: string[]; finishedNotifiedIds: string[] };
      return JSON.stringify({
        kickoffNotifiedIds: [...s.kickoffNotifiedIds].sort(),
        finishedNotifiedIds: [...s.finishedNotifiedIds].sort(),
      });
    }
    case "ticket":
      return JSON.stringify({ keys: [...(state as { keys: string[] }).keys].sort() });
    default:
      throw new Error(`未知策略：${policy}`);
  }
}
