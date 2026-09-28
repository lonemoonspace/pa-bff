// 从 app/.../domain/TicketPolicy.kt 逐行移植。乘车月票（Ruter）与通勤停车票（Bane NOR）的
// 有效期判定与到期提醒，纯逻辑、不碰 I/O。
//
// 本地时刻一律用 "yyyy-MM-ddTHH:mm" 字符串表示（Oslo 本地时间，分钟精度）：这个格式字典序
// 就是时间序，字符串比较即可代替 Kotlin 的 LocalDateTime.isAfter，避免手写日期运算。
import type { Settings } from "../contract/settings";
import { osloLocalDateTime } from "../util/time";

export type TicketKind = "TRANSIT" | "PARKING";
export type TicketStatusState = "ACTIVE" | "EXPIRING" | "EXPIRED";

export interface TicketStatus {
  kind: TicketKind;
  state: TicketStatusState;
  /** "yyyy-MM-ddTHH:mm"，Oslo 本地时间，分钟精度。 */
  until: string;
  /** 截止日期距今天的自然日数：今天为 0，明天为 1；已过期时可能为负或 0。 */
  daysUntil: number;
}

export interface TicketNotification {
  kind: TicketKind;
  title: string;
  body: string;
}

export interface TicketDecision {
  notifications: TicketNotification[];
  newKeys: string[];
}

/** 已发送过的提醒 key 集合；对应 Kotlin 的 NotifiedState，供 P5 的 notify 任务持久化。 */
export interface TicketState {
  keys: string[];
}

/** 截止日期距今天少于该自然日数时进入 EXPIRING 并提醒。 */
const WARN_DAYS = 3;

/** 提醒只在白天发，避免后台刷新半夜把人吵醒（[8, 21) 点）。 */
const NOTIFY_FROM_HOUR = 8;
const NOTIFY_UNTIL_HOUR = 21;

const STAGE_SOON = "soon";
const STAGE_LAST = "last";
const STAGES = [STAGE_SOON, STAGE_LAST] as const;

// v5.1.1 的 key 带秒（…T23:59:59:soon），规整成分钟格式，避免升级后同一档提醒重发。
const LEGACY_SECONDS_KEY = /(T\d{2}:\d{2}):\d{2}:/g;

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

function isValidDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  // 秒不存在时按 0 处理；存在时须在 0–59（对齐 Kotlin LocalDateTime.parse：
  // "...T23:59:60" 这类非法秒值直接解析失败，不算已配置）。
  if (second < 0 || second > 59) return false;
  return true;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 解析存储值；空串或格式错误返回 null。兼容旧值：v5.1.0 的纯日期 "yyyy-MM-dd" 按当天 23:59
 * 处理，v5.1.1 带秒的 "yyyy-MM-ddTHH:mm:ss" 截掉秒。
 */
export function parseUntil(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  const dtMatch = LOCAL_DATETIME_RE.exec(value);
  if (dtMatch) {
    const year = Number(dtMatch[1]);
    const month = Number(dtMatch[2]);
    const day = Number(dtMatch[3]);
    const hour = Number(dtMatch[4]);
    const minute = Number(dtMatch[5]);
    const second = dtMatch[6] ? Number(dtMatch[6]) : 0;
    if (!isValidDateTime(year, month, day, hour, minute, second)) return null;
    return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
  }

  const dateMatch = LOCAL_DATE_RE.exec(value);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (!isValidDateTime(year, month, day, 23, 59)) return null;
    return `${year}-${pad2(month)}-${pad2(day)}T23:59`;
  }

  return null;
}

function daysBetweenLocalDates(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toDate.split("-").map(Number) as [number, number, number];
  const diffMs = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(diffMs / 86400000);
}

function statusFor(kind: TicketKind, untilRaw: string, nowLocal: string): TicketStatus | null {
  const until = parseUntil(untilRaw);
  if (until === null) return null;
  const daysUntil = daysBetweenLocalDates(nowLocal.slice(0, 10), until.slice(0, 10));
  const state: TicketStatusState =
    nowLocal > until ? "EXPIRED" : daysUntil < WARN_DAYS ? "EXPIRING" : "ACTIVE";
  return { kind, state, until, daysUntil };
}

/** now 为某一时刻（转换为 Oslo 本地时间后参与比较）。 */
export function statuses(settings: Settings, now: Date): TicketStatus[] {
  const nowLocal = osloLocalDateTime(now);
  const result: TicketStatus[] = [];
  const transit = statusFor("TRANSIT", settings.transitPassUntil, nowLocal);
  if (transit) result.push(transit);
  const parking = statusFor("PARKING", settings.parkingPassUntil, nowLocal);
  if (parking) result.push(parking);
  return result;
}

function key(s: TicketStatus, stage: string): string {
  return `${s.kind}:${s.until}:${stage}`;
}

function label(kind: TicketKind): string {
  return kind === "TRANSIT" ? "乘车月票" : "停车票";
}

function title(s: TicketStatus): string {
  if (s.daysUntil === 0) return `${label(s.kind)}今天到期`;
  if (s.daysUntil === 1) return `${label(s.kind)}明天到期`;
  return `${label(s.kind)}还剩 ${s.daysUntil} 天`;
}

function displayUntil(until: string): string {
  const [datePart, timePart] = until.split("T") as [string, string];
  const [, month, day] = datePart.split("-").map(Number) as [number, number, number];
  return `${month}月${day}日 ${timePart}`;
}

function body(s: TicketStatus): string {
  const where = s.kind === "TRANSIT" ? "Ruter" : "Bane NOR Parkering";
  return `有效期至 ${displayUntil(s.until)}，记得在 ${where} 续买，并回到设置更新截止时间。`;
}

/**
 * 每张票、每个截止时间分两档各提醒一次：进入最后 WARN_DAYS 个自然日时（"soon"）与截止当天
 * （"last"）。key 带截止时间，续买后填入新时间自然会重新计提醒；不再对应当前截止时间的旧 key
 * 被清理。若第一次检查时已是截止当天，只发 "last"，不会连发两条。
 */
export function evaluate(settings: Settings, now: Date, previous: TicketState): TicketDecision {
  const nowLocal = osloLocalDateTime(now);
  const list = statuses(settings, now);
  const liveKeys = new Set<string>();
  for (const s of list) {
    for (const stage of STAGES) liveKeys.add(key(s, stage));
  }
  const kept = new Set(
    previous.keys
      .map((k) => k.replace(LEGACY_SECONDS_KEY, "$1:"))
      .filter((k) => liveKeys.has(k)),
  );

  const hour = Number(nowLocal.slice(11, 13));
  if (hour < NOTIFY_FROM_HOUR || hour >= NOTIFY_UNTIL_HOUR) {
    return { notifications: [], newKeys: [...kept].sort() };
  }

  const notifications: TicketNotification[] = [];
  for (const s of list) {
    if (s.state !== "EXPIRING") continue;
    const stage = s.daysUntil === 0 ? STAGE_LAST : STAGE_SOON;
    const k = key(s, stage);
    if (kept.has(k)) continue;
    if (stage === STAGE_LAST) kept.add(key(s, STAGE_SOON));
    kept.add(k);
    notifications.push({ kind: s.kind, title: title(s), body: body(s) });
  }
  return { notifications, newKeys: [...kept].sort() };
}

/**
 * 解析持久化的通知状态；null、非法 JSON、外形不对都回退 { keys: [] }
 * （对齐 Kotlin 的 runCatching）。供 P5 的 notify 任务读 notify_state。
 */
export function parseTicketState(json: string | null): TicketState {
  if (json === null) return { keys: [] };
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "keys" in parsed &&
      Array.isArray((parsed as { keys: unknown }).keys) &&
      (parsed as { keys: unknown[] }).keys.every((k) => typeof k === "string")
    ) {
      return { keys: [...(parsed as { keys: string[] }).keys].sort() };
    }
    return { keys: [] };
  } catch {
    return { keys: [] };
  }
}
