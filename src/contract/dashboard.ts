// 冻结契约（G1）。只有 Opus 关口提交可以修改本文件，见 bff/BRIEF.md「契约纪律」。
//
// /v1/dashboard 的数据形状与 Android v5 的缓存模型逐字段一致：
//   WeatherStatus / TrainStatus / TrafficStatus   ← app/.../domain/Models.kt
//   BusStatus                                    ← app/.../domain/BusModels.kt
//   FootballStatus                               ← app/.../domain/FootballModels.kt
// App 把 data 原样写进对应的 CacheStore 键（CACHE_WEATHER 等），现有界面零改动。
// 因此字段名、可空性、默认值都必须与 Kotlin 一致；Kotlin 端用 ignoreUnknownKeys 解码，
// 这里新增字段不会破坏旧 App，但删除或改名会。
//
// 时间戳约定：ISO-8601 带偏移。与奥斯陆本地时间相关的字段（班次时刻、updatedAt 等）
// 用 Europe/Oslo 偏移输出，例如 "2026-09-23T07:32:00+02:00"；football 的 updatedAt
// 与 Kotlin 的 Instant.toString() 一致，用 "Z"。
import { z } from "zod";

// ---------- 天气（Models.kt: WeatherStatus / DailyForecast） ----------
export const DailyForecastSchema = z.object({
  date: z.string().default(""),
  minTemp: z.number().default(0),
  maxTemp: z.number().default(0),
  symbolCode: z.string().default(""),
  precipMm: z.number().default(0),
});

export const WeatherStatusSchema = z.object({
  temperature: z.number().default(0),
  windSpeed: z.number().default(0),
  precip1h: z.number().default(0),
  symbolCode: z.string().default(""),
  tomorrowMorningTemp: z.number().nullable().default(null),
  tomorrowSymbol: z.string().default(""),
  updatedAt: z.string().default(""),
  observedAt: z.string().default(""),
  locationKey: z.string().default(""),
  daily: z.array(DailyForecastSchema).default([]),
});

// ---------- 火车（Models.kt: TrainStatus 及其子结构） ----------
export const PlanLegSchema = z.object({
  line: z.string().default(""),
  depTime: z.string().default(""),
  arrTime: z.string().default(""),
  fromName: z.string().default(""),
  toName: z.string().default(""),
  delayMin: z.number().int().default(0),
  cancelled: z.boolean().default(false),
  delayKnown: z.boolean().default(false),
});

export const OppositeStateSchema = z.enum(["NONE", "ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"]);

export const TrainPlanSchema = z.object({
  planText: z.string().default(""),
  legs: z.array(PlanLegSchema).default([]),
  adviceLevel: z.string().default("UNKNOWN"),
  adviceText: z.string().default(""),
  alternatives: z.array(z.string()).default([]),
  oppositeText: z.string().default(""),
  oppositeState: OppositeStateSchema.default("NONE"),
});

export const TransferLegSchema = z.object({
  line: z.string().default(""),
  fromName: z.string().default(""),
  toName: z.string().default(""),
  depTime: z.string().default(""),
  arrTime: z.string().default(""),
  delayMin: z.number().int().default(0),
  cancelled: z.boolean().default(false),
  delayKnown: z.boolean().default(false),
});

export const TransferOptionSchema = z.object({
  l1: TransferLegSchema.default(TransferLegSchema.parse({})),
  r14: TransferLegSchema.default(TransferLegSchema.parse({})),
  waitMin: z.number().int().default(0),
  directArrTime: z.string().default(""),
  savedMin: z.number().int().nullable().default(null),
});

export const TransferBoardSchema = z.object({
  transferStation: z.string().default(""),
  options: z.array(TransferOptionSchema).default([]),
  updatedAt: z.string().default(""),
});

export const TrainStatusSchema = z.object({
  work: TrainPlanSchema.default(TrainPlanSchema.parse({})),
  home: TrainPlanSchema.default(TrainPlanSchema.parse({})),
  transfer: TransferBoardSchema.nullable().default(null),
  updatedAt: z.string().default(""),
  originStation: z.string().default(""),
  destinationStation: z.string().default(""),
});

// ---------- 路况（Models.kt: TrafficStatus） ----------
export const TrafficStatusSchema = z.object({
  durationSec: z.number().int().default(0),
  staticDurationSec: z.number().int().default(0),
  delaySec: z.number().int().default(0),
  distanceMeters: z.number().int().default(0),
  level: z.string().default("UNKNOWN"),
  origin: z.string().default(""),
  destination: z.string().default(""),
  updatedAt: z.string().default(""),
});

// ---------- 关注线路（BusModels.kt，CONTRACT 第 9 节） ----------
export const BusDepartureSchema = z.object({
  depTime: z.string().default(""),
  destName: z.string().default(""),
  delayMin: z.number().int().default(0),
  cancelled: z.boolean().default(false),
  delayKnown: z.boolean().default(false),
});

export const BusBoardSchema = z.object({
  boardStop: z.string().default(""),
  towardStop: z.string().default(""),
  departures: z.array(BusDepartureSchema).default([]),
});

export const BusStatusSchema = z.object({
  boards: z.array(BusBoardSchema).default([]),
  updatedAt: z.string().default(""),
  // [gate] P9：关注线路的对外线路号（例如 "42"），卡片标题用；旧缓存没有该字段时为空串。
  lineCode: z.string().default(""),
});

// ---------- 皇马（FootballModels.kt） ----------
export const MatchUiSchema = z.object({
  idEvent: z.string().default(""),
  timestamp: z.string().default(""),
  title: z.string().default(""),
  league: z.string().default(""),
  homeTeam: z.string().default(""),
  awayTeam: z.string().default(""),
  homeScore: z.number().int().nullable().default(null),
  awayScore: z.number().int().nullable().default(null),
  status: z.string().default(""),
  homeBadge: z.string().nullable().default(null),
  awayBadge: z.string().nullable().default(null),
  venue: z.string().nullable().default(null),
  isHome: z.boolean().default(false),
});

export const StandingRowSchema = z.object({
  position: z.number().int(),
  teamName: z.string(),
  crest: z.string().nullable().default(null),
  played: z.number().int().default(0),
  won: z.number().int().default(0),
  draw: z.number().int().default(0),
  lost: z.number().int().default(0),
  goalsFor: z.number().int().default(0),
  goalsAgainst: z.number().int().default(0),
  goalDifference: z.number().int().default(0),
  points: z.number().int().default(0),
  isRealMadrid: z.boolean().default(false),
});

export const ScorerRowSchema = z.object({
  rank: z.number().int(),
  playerName: z.string(),
  teamName: z.string(),
  crest: z.string().nullable().default(null),
  goals: z.number().int().default(0),
  penalties: z.number().int().nullable().default(null),
  playedMatches: z.number().int().nullable().default(null),
  isRealMadrid: z.boolean().default(false),
});

export const LeagueTablesSchema = z.object({
  standings: z.array(StandingRowSchema).default([]),
  scorers: z.array(ScorerRowSchema).default([]),
  currentMatchday: z.number().int().nullable().default(null),
  updatedAt: z.string().default(""),
});

export const FootballStatusSchema = z.object({
  nextMatches: z.array(MatchUiSchema).default([]),
  lastMatches: z.array(MatchUiSchema).default([]),
  updatedAt: z.string().default(""),
  league: LeagueTablesSchema.nullable().default(null),
});

// ---------- 信封：每个来源都包一层新鲜度信息 ----------
/**
 * ok             最近一次刷新成功（或 304 未变化）
 * stale          最近一次刷新失败，data 是上一次成功的结果（可能为 null）
 * not_configured 缺少必需的设置或密钥（例如没填地址、没设 Google Key），data 为 null
 * idle           按日程本来就不刷新（例如窗口外的路况），data 为最后一次结果或 null
 */
export const SourceStateSchema = z.enum(["ok", "stale", "not_configured", "idle"]);

export const SourceErrorSchema = z.object({
  code: z.string(), // 例：upstream_timeout / upstream_4xx / upstream_5xx / parse_error / cpu_budget
  message: z.string(),
  at: z.string(),
});

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    state: SourceStateSchema,
    fetchedAt: z.string().nullable(), // 最近一次成功拿到数据（含 304）的时刻
    observedAt: z.string().nullable(), // 数据本身描述的时刻；无法区分时等于 fetchedAt
    error: SourceErrorSchema.nullable(),
    data: data.nullable(),
  });

/** 键名与 App 的 CacheStore 键一一对应（见 BRIEF.md「缓存键映射」）。 */
export const DashboardSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  settingsRevision: z.number().int(),
  window: z.enum(["WORK", "RETURN", "OUTSIDE"]),
  sources: z.object({
    weather: envelope(WeatherStatusSchema),
    train: envelope(TrainStatusSchema),
    trafficOutbound: envelope(TrafficStatusSchema),
    trafficReturn: envelope(TrafficStatusSchema),
    bus: envelope(BusStatusSchema),
    football: envelope(FootballStatusSchema),
  }),
});

export type WeatherStatus = z.infer<typeof WeatherStatusSchema>;
export type TrainStatus = z.infer<typeof TrainStatusSchema>;
export type TrainPlan = z.infer<typeof TrainPlanSchema>;
export type PlanLeg = z.infer<typeof PlanLegSchema>;
export type TransferBoard = z.infer<typeof TransferBoardSchema>;
export type TrafficStatus = z.infer<typeof TrafficStatusSchema>;
export type BusStatus = z.infer<typeof BusStatusSchema>;
export type FootballStatus = z.infer<typeof FootballStatusSchema>;
export type MatchUi = z.infer<typeof MatchUiSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type SourceKey = keyof Dashboard["sources"];
