// football-data.org API v4 客户端，移植自
// app/.../data/football/FootballDataOrgApi.kt（免费计划）。皇马标签页目前唯一的数据源。
import { z } from "zod";
import { registerTester } from "../secrets/testers";
import { fetchJson, SourceFailure } from "./http";

/** football-data.org 里皇马的球队 ID，与设置页「测试连接」共用。 */
export const FDO_TEAM_ID = 86;

const BASE_URL = "https://api.football-data.org/v4/";
// 赛程窗口：从 now 回溯/展望多少天，保证不管当前赛季进行到第几轮，最近赛果与近期赛程
// 都落在响应窗口内（不带日期参数时接口只返回当前赛季升序的前 N 场，赛季过半后就取不到
// 最近的比赛了）。
const LOOKBACK_DAYS = 120;
const LOOKAHEAD_DAYS = 180;
const LIMIT = 100;
/** 西甲在 football-data.org 的赛事代码（免费计划包含）。 */
const LA_LIGA = "PD";
const SCORERS_LIMIT = 20;

const FdoTeamSchema = z.object({
  id: z.number(),
  name: z.string().default(""),
  crest: z.string().nullable().default(null),
});

const FdoCompetitionSchema = z.object({ name: z.string().default("") });

const FdoFullTimeSchema = z.object({
  home: z.number().nullable().default(null),
  away: z.number().nullable().default(null),
});

const FdoScoreSchema = z.object({ fullTime: FdoFullTimeSchema.nullable().default(null) });

const FdoMatchSchema = z.object({
  id: z.number(),
  competition: FdoCompetitionSchema.nullable().default(null),
  utcDate: z.string().default(""),
  status: z.string().default(""),
  matchday: z.number().nullable().default(null),
  homeTeam: FdoTeamSchema,
  awayTeam: FdoTeamSchema,
  score: FdoScoreSchema.nullable().default(null),
});

const FdoMatchEnvelopeSchema = z.object({ matches: z.array(FdoMatchSchema).default([]) });

const FdoSeasonSchema = z.object({ currentMatchday: z.number().nullable().default(null) });

const FdoTableTeamSchema = z.object({
  id: z.number(),
  name: z.string().default(""),
  shortName: z.string().nullable().default(null),
  crest: z.string().nullable().default(null),
});

const FdoTableRowSchema = z.object({
  position: z.number(),
  team: FdoTableTeamSchema,
  playedGames: z.number().default(0),
  won: z.number().default(0),
  draw: z.number().default(0),
  lost: z.number().default(0),
  points: z.number().default(0),
  goalsFor: z.number().default(0),
  goalsAgainst: z.number().default(0),
  goalDifference: z.number().default(0),
});

const FdoStandingGroupSchema = z.object({
  type: z.string().default(""),
  table: z.array(FdoTableRowSchema).default([]),
});

const FdoStandingsEnvelopeSchema = z.object({
  season: FdoSeasonSchema.nullable().default(null),
  standings: z.array(FdoStandingGroupSchema).default([]),
});

const FdoPlayerSchema = z.object({ name: z.string().default("") });

const FdoScorerSchema = z.object({
  player: FdoPlayerSchema,
  team: FdoTableTeamSchema,
  playedMatches: z.number().nullable().default(null),
  goals: z.number().nullable().default(null),
  penalties: z.number().nullable().default(null),
});

const FdoScorersEnvelopeSchema = z.object({
  season: FdoSeasonSchema.nullable().default(null),
  scorers: z.array(FdoScorerSchema).default([]),
});

export type FdoTeam = z.infer<typeof FdoTeamSchema>;
export type FdoMatch = z.infer<typeof FdoMatchSchema>;
export type FdoTableTeam = z.infer<typeof FdoTableTeamSchema>;
export type FdoTableRow = z.infer<typeof FdoTableRowSchema>;
export type FdoStandingGroup = z.infer<typeof FdoStandingGroupSchema>;
export type FdoStandingsEnvelope = z.infer<typeof FdoStandingsEnvelopeSchema>;
export type FdoScorer = z.infer<typeof FdoScorerSchema>;
export type FdoScorersEnvelope = z.infer<typeof FdoScorersEnvelopeSchema>;

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 对齐 FootballDataOrgApi.kt 的 requireApiKey：未配置 key 时给出指向设置页的明确错误。 */
export class InvalidApiKeyError extends Error {}

function requireApiKey(apiKey: string): void {
  if (!apiKey.trim()) {
    throw new InvalidApiKeyError("未配置 football-data.org API Key，请在「设置 → 皇马」中填写并保存");
  }
}

/** 发一次 football-data.org 请求并按 [schema] 校验/兜默认值；形状不对时归为 parse_error。 */
async function getFdoJson<T>(url: string, apiKey: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const result = await fetchJson<unknown>(
    url,
    { headers: { "X-Auth-Token": apiKey } },
    { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
  );
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    throw new SourceFailure("parse_error", `football-data.org 响应解析失败：${url}`, { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * 获取 [teamId] 在 [now] 前后日期窗口内的比赛（FINISHED / SCHEDULED / TIMED 等）。
 * 必须显式传 dateFrom/dateTo，理由见文件顶部注释。
 */
export async function fetchTeamMatches(
  teamId: number,
  apiKey: string,
  now: Date,
  signal?: AbortSignal,
): Promise<FdoMatch[]> {
  requireApiKey(apiKey);
  const dateFrom = toDateOnly(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));
  const dateTo = toDateOnly(new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000));
  const url = `${BASE_URL}teams/${teamId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=${LIMIT}`;
  const envelope = await getFdoJson(url, apiKey, FdoMatchEnvelopeSchema, signal);
  return envelope.matches;
}

/** 西甲（PD）当前赛季积分榜，只取 TOTAL 表（调用方负责挑选）。 */
export async function fetchLaLigaStandings(apiKey: string, signal?: AbortSignal): Promise<FdoStandingsEnvelope> {
  requireApiKey(apiKey);
  return getFdoJson(`${BASE_URL}competitions/${LA_LIGA}/standings`, apiKey, FdoStandingsEnvelopeSchema, signal);
}

/** 西甲当前赛季射手榜（按进球降序）。 */
export async function fetchLaLigaScorers(
  apiKey: string,
  signal?: AbortSignal,
  limit: number = SCORERS_LIMIT,
): Promise<FdoScorersEnvelope> {
  requireApiKey(apiKey);
  return getFdoJson(`${BASE_URL}competitions/${LA_LIGA}/scorers?limit=${limit}`, apiKey, FdoScorersEnvelopeSchema, signal);
}

/** 设置页「测试连接」：请求一次球队资源验证 Key 有效性，HTTP 200 视为成功。 */
export async function verifyKey(apiKey: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  requireApiKey(apiKey);
  try {
    await fetchJson(
      `${BASE_URL}teams/${FDO_TEAM_ID}`,
      { headers: { "X-Auth-Token": apiKey } },
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    return { ok: true, message: "football-data.org 连接成功" };
  } catch (err) {
    if (err instanceof SourceFailure && err.code === "upstream_4xx") {
      return { ok: false, message: `football-data.org 拒绝了该 Key（请检查是否免费注册并填写正确）：${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `football-data.org 测试失败：${message}` };
  }
}

// 模块被 import（jobs/index.ts -> jobs/football.ts -> 这里）时注册一次；测试文件里
// registerTester 是幂等覆盖的，不会因为重复 import 出问题。
registerTester("football_data", async (_env, plaintext) => verifyKey(plaintext));
