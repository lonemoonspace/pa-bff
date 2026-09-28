// football 任务：从 app/.../data/football/FootballRepository.kt（+FootballDataOrgApi.kt）
// 移植。卡上只允许改本文件、sources/football.ts、util/rate-bucket.ts、jobs/index.ts，
// 纯逻辑（挑选近期赛程/赛果、积分榜/射手榜整理）直接写在这里，不新开 domain/ 文件。
import type { z } from "zod";
import type { FootballStatus, MatchUi } from "../contract/dashboard";
import { LeagueTablesSchema, ScorerRowSchema, StandingRowSchema } from "../contract/dashboard";
import type { Env } from "../env";
import type { CadenceCtx } from "../scheduler/cadence";
import { getSecretPlain } from "../secrets/store";
import {
  FDO_TEAM_ID,
  fetchLaLigaScorers,
  fetchLaLigaStandings,
  fetchTeamMatches,
  type FdoMatch,
  type FdoScorersEnvelope,
  type FdoStandingsEnvelope,
} from "../sources/football";
import { SourceFailure, type SourceFailureCode } from "../sources/http";
import * as snapshot from "../snapshot/store";
import { takeToken } from "../util/rate-bucket";

// contract/dashboard.ts 只导出了 FootballStatus / MatchUi 的类型别名，没有单独导出
// LeagueTables / StandingRow / ScorerRow（虽然对应的 Schema 是导出的）；契约文件冻结、
// 不能改，这里直接用 z.infer 从已导出的 Schema 派生等价类型，不新增契约内容。
type LeagueTables = z.infer<typeof LeagueTablesSchema>;
type StandingRow = z.infer<typeof StandingRowSchema>;
type ScorerRow = z.infer<typeof ScorerRowSchema>;

const SOURCE = "football";
// P3 通用约定：football 的 configKey 固定为 "86"（球队 ID），设置页没有可配置项。
const CONFIG_KEY = "86";
const RATE_BUCKET_NAME = "football_data";

/** 最近赛程/赛果列表最大条数，对齐 FootballRepository.MAX_MATCHES。 */
const MAX_MATCHES = 3;
/**
 * 「近期赛程」与「最近赛果」共用的开球宽限边界（分钟），对齐
 * FootballRepository.KICKOFF_GRACE_MIN：selectUpcoming 取 >= now-该值的比赛，
 * selectRecent 取 < 该值的比赛，两者互斥。
 */
const KICKOFF_GRACE_MIN = 5;
/** 积分榜/射手榜缓存有效期（分钟），对齐 FootballRepository.LEAGUE_TTL_MIN。 */
const LEAGUE_TTL_MIN = 30;
/**
 * 估算一场比赛的「终场」时刻：football-data.org 不提供比赛结束时间，只有 status 字段，
 * 用 90 分钟正赛 + 补时/中场 + 缓冲估算为 130 分钟。与 CONTRACT.md 第 5 节「开球前 90
 * 分钟到终场之间每分钟」的调度意图对齐——估算偏长最多让轮询多跑几分钟，偏短则会提前
 * 回落到 6 小时间隔，宁可偏长。
 */
const ESTIMATED_MATCH_DURATION_MIN = 130;

function parseFdoInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fdoToMatchUi(m: FdoMatch): MatchUi {
  return {
    idEvent: String(m.id),
    timestamp: m.utcDate,
    title: `${m.homeTeam.name} vs ${m.awayTeam.name}`,
    league: m.competition?.name ?? "",
    homeTeam: m.homeTeam.name,
    awayTeam: m.awayTeam.name,
    homeScore: m.score?.fullTime?.home ?? null,
    awayScore: m.score?.fullTime?.away ?? null,
    status: m.status,
    homeBadge: m.homeTeam.crest ?? null,
    awayBadge: m.awayTeam.crest ?? null,
    venue: null,
    isHome: m.homeTeam.id === FDO_TEAM_ID,
  };
}

/** 接下来三场（按 utcDate 升序），对齐 FootballRepository.selectUpcoming。 */
function selectUpcoming(matches: FdoMatch[], now: Date): FdoMatch[] {
  const boundary = now.getTime() - KICKOFF_GRACE_MIN * 60_000;
  const timed = matches
    .map((m) => ({ at: parseFdoInstant(m.utcDate), m }))
    .filter((x): x is { at: Date; m: FdoMatch } => x.at !== null);
  const scheduled = timed
    .filter(({ at }) => at.getTime() >= boundary)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ m }) => m);
  // undated 只是兜底：不该挤掉已排序的真实赛程（与 Kotlin 版同样的教训）。
  const undated = matches.filter((m) => !m.utcDate);
  if (scheduled.length >= MAX_MATCHES) return scheduled.slice(0, MAX_MATCHES);
  return [...scheduled, ...undated].slice(0, MAX_MATCHES);
}

/** 最近三场赛果（utcDate 已过，倒序取最新），对齐 FootballRepository.selectRecent。 */
function selectRecent(matches: FdoMatch[], now: Date): FdoMatch[] {
  const boundary = now.getTime() - KICKOFF_GRACE_MIN * 60_000;
  return matches
    .map((m) => ({ at: parseFdoInstant(m.utcDate), m }))
    .filter((x): x is { at: Date; m: FdoMatch } => x.at !== null && x.at.getTime() < boundary)
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map(({ m }) => m)
    .slice(0, MAX_MATCHES);
}

/** 同进球数并列同名次（1, 2, 2, 4…），对齐 FootballRepository.toScorerRows。 */
function toScorerRows(envelope: FdoScorersEnvelope): ScorerRow[] {
  const sorted = [...envelope.scorers].sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0));
  return sorted.map((s, index) => {
    const goals = s.goals ?? 0;
    const rank = sorted.findIndex((x) => (x.goals ?? 0) === goals) + 1;
    return {
      rank: rank > 0 ? rank : index + 1,
      playerName: s.player.name,
      teamName: s.team.shortName?.trim() ? s.team.shortName : s.team.name,
      crest: s.team.crest,
      goals,
      penalties: s.penalties,
      playedMatches: s.playedMatches,
      isRealMadrid: s.team.id === FDO_TEAM_ID,
    };
  });
}

/** 对齐 FootballRepository.toStandingRows：只取 TOTAL 表，没有则取第一个分组。 */
function toStandingRows(envelope: FdoStandingsEnvelope): StandingRow[] {
  const table = envelope.standings.find((g) => g.type === "TOTAL") ?? envelope.standings[0];
  const rows = table?.table ?? [];
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      position: row.position,
      teamName: row.team.shortName?.trim() ? row.team.shortName : row.team.name,
      crest: row.team.crest,
      played: row.playedGames,
      won: row.won,
      draw: row.draw,
      lost: row.lost,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      goalDifference: row.goalDifference,
      points: row.points,
      isRealMadrid: row.team.id === FDO_TEAM_ID,
    }));
}

/**
 * 榜单只在比赛结束后变化，赛程刷新却是分钟级的，[LEAGUE_TTL_MIN] 内直接复用上次结果；
 * 任一榜单请求失败都不影响赛程主流程，沿用 [previous]（没有则为 null）。
 *
 * F9：standings/scorers 是两个独立的真实请求，各自要扣一个令牌（不是「一次刷新扣 1
 * 个」）——football-data.org 按实际请求数限流，令牌桶必须如实反映每一次真实发出的
 * 请求，否则容量 10/分钟的桶会在不知不觉中放行远超 10 个真实请求。令牌不足时（哪怕
 * 只差一个）整体跳过这次榜单刷新，不做「只请求一半」的半吊子状态，沿用旧榜单。
 */
async function refreshLeagueTables(
  env: Env,
  apiKey: string,
  previous: LeagueTables | null,
  now: Date,
  signal: AbortSignal,
): Promise<LeagueTables | null> {
  const previousAt = parseFdoInstant(previous?.updatedAt);
  if (previousAt && previousAt.getTime() > now.getTime() - LEAGUE_TTL_MIN * 60_000) {
    return previous;
  }
  const hasStandingsToken = await takeToken(env, RATE_BUCKET_NAME, now);
  if (!hasStandingsToken) return previous;
  const hasScorersToken = await takeToken(env, RATE_BUCKET_NAME, now);
  if (!hasScorersToken) return previous;
  try {
    const [standings, scorers] = await Promise.all([
      fetchLaLigaStandings(apiKey, signal),
      fetchLaLigaScorers(apiKey, signal),
    ]);
    return {
      standings: toStandingRows(standings),
      scorers: toScorerRows(scorers),
      currentMatchday: standings.season?.currentMatchday ?? scorers.season?.currentMatchday ?? null,
      updatedAt: now.toISOString(),
    };
  } catch {
    return previous;
  }
}

/**
 * 下一场需要关注的比赛（供 cadence.ts 的 nextFootball 用）：优先取「正处于活跃窗口」
 * （开球前 90 分钟到估算终场之间）的那场；否则取最近的未来比赛；都没有则 null。
 */
function nextRelevantMatch(matches: FdoMatch[], now: Date): { kickoffAt: Date; endAt: Date } | null {
  const timed = matches
    .map((m) => ({ at: parseFdoInstant(m.utcDate), m }))
    .filter((x): x is { at: Date; m: FdoMatch } => x.at !== null);
  if (timed.length === 0) return null;

  const durationMs = ESTIMATED_MATCH_DURATION_MIN * 60_000;
  const active = timed.find(
    ({ at }) => now.getTime() >= at.getTime() - 90 * 60_000 && now.getTime() < at.getTime() + durationMs,
  );
  const chosen =
    active ??
    timed
      .filter(({ at }) => at.getTime() >= now.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!chosen) return null;
  return { kickoffAt: chosen.at, endAt: new Date(chosen.at.getTime() + durationMs) };
}

/**
 * 窗口内没有任何比赛：不是 HTTP 层面的失败，http.ts 的 SourceFailureCode 联合类型里
 * 没有对应取值（本卡不允许改 sources/http.ts），单独定义一个错误类型，归类时给它自己
 * 的错误码 "empty_window"（SourceErrorSchema.code 是自由字符串，不受该联合类型限制）。
 */
class EmptyWindowError extends Error {}

function toSourceFailure(err: unknown, now: Date): { code: SourceFailureCode | string; message: string; at: string } {
  if (err instanceof SourceFailure) {
    return { code: err.code, message: err.message, at: now.toISOString() };
  }
  if (err instanceof EmptyWindowError) {
    return { code: "empty_window", message: err.message, at: now.toISOString() };
  }
  return {
    code: "upstream_5xx",
    message: err instanceof Error ? err.message : String(err),
    at: now.toISOString(),
  };
}

/** football 任务处理器；由 jobs/index.ts 注册为 "football"。 */
export async function footballJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  const apiKey = await getSecretPlain(env, "football_data");
  if (!apiKey || !apiKey.trim()) {
    await snapshot.putState(env, SOURCE, "not_configured", null, now);
    return;
  }

  // 令牌桶先于任何请求判定：耗尽时不发请求，直接失败并让调度退避，避免打穿
  // football-data.org 免费计划 10 次/分钟的限额（尤其是手动刷新叠加轮询时）。
  const hasToken = await takeToken(env, RATE_BUCKET_NAME, now);
  if (!hasToken) {
    const error = { code: "rate_limited", message: "football-data.org 令牌桶已耗尽，本次跳过请求", at: now.toISOString() };
    await snapshot.putFailure(env, SOURCE, error, CONFIG_KEY, now);
    throw new Error(error.message);
  }

  const prior = await snapshot.get(env, SOURCE, CONFIG_KEY);
  const previousLeague = (prior?.data as FootballStatus | null)?.league ?? null;

  try {
    const matches = await fetchTeamMatches(FDO_TEAM_ID, apiKey, now, signal);
    if (matches.length === 0) {
      // 窗口内没有任何比赛（如赛季切换期数据未就绪）：整体报错，不做赛程兜底，
      // 与 FootballRepository.refresh 的行为一致。
      throw new EmptyWindowError(
        "football-data.org 未返回可用赛程数据（日期窗口内暂无比赛，或当前赛季数据未就绪）",
      );
    }

    const league = await refreshLeagueTables(env, apiKey, previousLeague, now, signal);

    const status: FootballStatus = {
      nextMatches: selectUpcoming(matches, now).map(fdoToMatchUi),
      lastMatches: selectRecent(matches, now).map(fdoToMatchUi),
      // Kotlin 端用 Instant.toString()（"...Z"），这里保持一致，不走 Oslo 偏移。
      updatedAt: now.toISOString(),
      league,
    };

    await snapshot.putSuccess(
      env,
      SOURCE,
      status,
      { observedAt: now.toISOString(), configKey: CONFIG_KEY },
      now,
    );

    return { football: nextRelevantMatch(matches, now) };
  } catch (err) {
    await snapshot.putFailure(env, SOURCE, toSourceFailure(err, now), CONFIG_KEY, now);
    // 失败一律上抛（不同于 weather）：football 正常间隔是 6 小时，若像 weather 那样吞掉
    // 异常会导致失败后仍按 6 小时的正常间隔等待下一次；上抛后 tick.ts 会保留「抢租约时
    // 预扣」的指数退避（2/4/8/16/30 分钟封顶），无论是本地令牌桶耗尽还是上游 429，
    // 都能更快重试，这正是任务卡要求的「429 → 返回让调度退避的结果」。
    throw err instanceof Error ? err : new Error(String(err));
  }
}
