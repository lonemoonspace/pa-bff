// 从 app/.../domain/FootballNotifyPolicy.kt 逐行移植：判断「皇马比赛是否该发通知」。
// 去重按「比赛 id + 通知类型」分别进行：开赛提醒与终场比分是两条独立通知，互不抑制。
import type { FootballStatus, MatchUi } from "../contract/dashboard";
import { formatIsoHm, minutesBetween } from "../util/time";

/** 开赛提醒窗口（分钟）：等于窗口外的刷新间隔，保证开赛前至少命中一次检查。 */
const KICKOFF_REMINDER_WINDOW_MIN = 60;

/** 赛前状态码：football-data.org 用 SCHEDULED/TIMED；旧缓存兼容 TheSportsDB 的 NS。 */
const PRE_MATCH_STATUSES = new Set(["SCHEDULED", "TIMED", "NS"]);

/** 已结束状态码：football-data.org 用 FINISHED；旧缓存兼容 TheSportsDB 的 FT。 */
const FINISHED_STATUSES = new Set(["FINISHED", "FT"]);

/** 已发送过的通知记录，按「比赛 id + 通知类型」去重；两个集合升序排列。 */
export interface NotifiedState {
  kickoffNotifiedIds: string[];
  finishedNotifiedIds: string[];
}

export interface MatchNotification {
  title: string;
  body: string;
  matchId: string;
}

export interface FootballNotifyDecision {
  notifications: MatchNotification[];
  newState: NotifiedState;
}

// football-data.org 的 utcDate（[MatchUi.timestamp]）在 Kotlin 端用 `Instant.parse` 解析——
// 与通用的 `TimeUtils.parseIso`（进而 bff 的 `parseIso`）不同，`Instant.parse`：
// - 秒是必填的（`parseIso` 允许省略）
// - 偏移接受 "Z"/"z" 或完整的 "±HH:MM"（大小写不敏感），但**不接受**短偏移 "+02"
//   （`parseIso` 对齐 Kotlin `OffsetDateTime.parse` 是接受短偏移的，这里的 Instant.parse 不接受）
// - 不接受 RFC 1123 格式
// 这里单独写一个严格的 instant 解析器，不能复用 `util/time.ts` 的 `parseIso`（规则不完全一样，
// 会把本该解析失败/成功的形态搞反，从而多发或少发开赛提醒）。
const STRICT_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

function daysInMonthStrict(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 31;
}

function parseOffsetMinutes(offset: string): number | null {
  if (offset === "Z" || offset === "z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function parseStrictInstant(s: string): Date | null {
  const match = STRICT_INSTANT_RE.exec(s);
  if (!match) return null;
  const [, yy, mm, dd, hh, mi, ss, , offset] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const year = Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonthStrict(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offsetMinutes = parseOffsetMinutes(offset);
  if (offsetMinutes === null) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000);
}

export function evaluate(
  status: FootballStatus | null,
  now: Date,
  previousState: NotifiedState,
): FootballNotifyDecision {
  if (!status) return { notifications: [], newState: previousState };

  const matches: MatchUi[] = [...status.nextMatches, ...status.lastMatches];
  const notifications: MatchNotification[] = [];
  const kickoffIds = new Set(previousState.kickoffNotifiedIds);
  const finishedIds = new Set(previousState.finishedNotifiedIds);

  for (const match of matches) {
    // 没有 id 的比赛无法可靠去重，跳过。
    if (match.idEvent.trim() === "") continue;
    const statusCode = match.status.toUpperCase();

    // 开赛提醒：状态仍是赛前 + 距开赛 <= 60 分钟 + 这场比赛还没提醒过。
    if (PRE_MATCH_STATUSES.has(statusCode) && !kickoffIds.has(match.idEvent)) {
      const kickoff = parseStrictInstant(match.timestamp);
      if (kickoff) {
        const minutesUntil = minutesBetween(now, kickoff);
        if (minutesUntil >= 0 && minutesUntil <= KICKOFF_REMINDER_WINDOW_MIN) {
          notifications.push(kickoffNotification(match));
          kickoffIds.add(match.idEvent);
        }
      }
    }

    // 终场比分：状态已结束 + 有比分 + 这场比赛还没推过终场比分。
    if (
      FINISHED_STATUSES.has(statusCode) &&
      !finishedIds.has(match.idEvent) &&
      match.homeScore !== null &&
      match.awayScore !== null
    ) {
      notifications.push(finishedNotification(match));
      finishedIds.add(match.idEvent);
    }
  }

  // 只保留当前仍在展示窗口内的比赛 id，避免集合随时间无限增长。
  const presentIds = new Set(matches.map((m) => m.idEvent));
  const newState: NotifiedState = {
    kickoffNotifiedIds: [...kickoffIds].filter((id) => presentIds.has(id)).sort(),
    finishedNotifiedIds: [...finishedIds].filter((id) => presentIds.has(id)).sort(),
  };

  return { notifications, newState };
}

function kickoffNotification(match: MatchUi): MatchNotification {
  const opponent = opponentOf(match);
  const at = formatIsoHm(match.timestamp);
  return {
    title: `皇马 vs ${opponent}`,
    body: `${match.league} · ${at} 开球`,
    matchId: match.idEvent,
  };
}

function finishedNotification(match: MatchUi): MatchNotification {
  return {
    title: "皇马比赛结束",
    body: `${match.homeTeam} ${match.homeScore}:${match.awayScore} ${match.awayTeam} · ${match.league}`,
    matchId: match.idEvent,
  };
}

function opponentOf(match: MatchUi): string {
  return match.isHome ? match.awayTeam : match.homeTeam;
}

function initialState(): NotifiedState {
  // 每次返回新对象字面量，不返回共享的模块级单例——调用方（notify 任务）可能会在
  // 原地基于返回值继续构造下一份状态，共享同一个对象会让不同调用之间意外互相影响。
  return { kickoffNotifiedIds: [], finishedNotifiedIds: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * 解析持久化状态，对齐 Kotlin kotlinx 的解码行为：
 * - JSON.parse 失败、结果不是「普通对象」（含数组）→ 整体回退
 * - 字段缺失 → 该字段按 kotlinx 的默认值取 `[]`（不是整体回退）
 * - 字段存在但不是 string[]（含元素非字符串、字段本身为 null）→ **整体**回退，
 *   不是「这个字段退到 []」——kotlinx 遇到类型不匹配的字段是整条解码失败，不会
 *   把出错的字段单独兜底成默认值
 * - 未知字段忽略（kotlinx 默认 ignoreUnknownKeys 行为，这里用的 Json 与
 *   FootballNotifyPolicy.NotifiedState 的实际解码方式一致）
 * - 两个集合去重（kotlinx 把 List<String> 赋进 Set<String> 时天然去重）并升序排列
 */
export function parseFootballNotifyState(json: string | null): NotifiedState {
  if (json === null) return initialState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return initialState();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return initialState();

  const obj = parsed as Record<string, unknown>;
  const kickoffRaw = "kickoffNotifiedIds" in obj ? obj.kickoffNotifiedIds : [];
  const finishedRaw = "finishedNotifiedIds" in obj ? obj.finishedNotifiedIds : [];
  if (!isStringArray(kickoffRaw) || !isStringArray(finishedRaw)) return initialState();

  return {
    kickoffNotifiedIds: [...new Set(kickoffRaw)].sort(),
    finishedNotifiedIds: [...new Set(finishedRaw)].sort(),
  };
}
