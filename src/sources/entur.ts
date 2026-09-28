// 从 app/.../data/entur/EnturApi.kt 移植。字段/请求形状与 Kotlin 源码逐一对应，
// 差异见各函数注释；Kotlin 端「同一文件四种不同错误处理风格」的历史不一致，这里
// 统一走 src/sources/http.ts 的 SourceFailure 分类，不照搬其不一致之处。
import { z } from "zod";
import type { FetchJsonOptions } from "./http";
import { fetchJson, SourceFailure } from "./http";

const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";
const GEOCODER_URL = "https://api.entur.io/geocoder/v3/autocomplete";

// 契约里 App 侧用的是 "personal-assistant-app"；BFF 是独立客户端，用自己的名字
// 上报给 Entur（Entur 用这个头做用量统计/联系方式，不影响响应形状）。
const CLIENT_NAME = "personal-assistant-bff";

// 单次请求超时：tick 的 CPU/墙钟预算有限，不能让一次 GraphQL 请求无限挂起。
const DEFAULT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------
// 响应形状：用 zod 解析，未知字段忽略（z.object 默认 strip），缺字段给默认值
// （对齐 Kotlin @Serializable data class 的默认参数），解析失败统一归为 parse_error。
// ---------------------------------------------------------------------

const DestinationDisplaySchema = z.object({
  frontText: z.string().nullable().default(null),
});

const EnturLineSchema = z.object({
  publicCode: z.string().nullable().default(null),
});

const EnturJourneyPatternSchema = z.object({
  line: EnturLineSchema.nullable().default(null),
});

const EnturQuaySchema = z.object({
  name: z.string().nullable().default(null),
});

const EnturStopCallSchema = z.object({
  quay: EnturQuaySchema.nullable().default(null),
  aimedArrivalTime: z.string().nullable().default(null),
  expectedArrivalTime: z.string().nullable().default(null),
});

const EnturServiceJourneySchema = z.object({
  transportMode: z.string().nullable().default(null),
  journeyPattern: EnturJourneyPatternSchema.nullable().default(null),
  estimatedCalls: z.array(EnturStopCallSchema).default([]),
});

export const StopDepartureSchema = z.object({
  realtime: z.boolean().default(false),
  aimedDepartureTime: z.string().nullable().default(null),
  expectedDepartureTime: z.string().nullable().default(null),
  cancellation: z.boolean().default(false),
  destinationDisplay: DestinationDisplaySchema.nullable().default(null),
  serviceJourney: EnturServiceJourneySchema.nullable().default(null),
});
export type StopDeparture = z.infer<typeof StopDepartureSchema>;

const StopPlaceDataSchema = z.object({
  name: z.string().nullable().default(null),
  estimatedCalls: z.array(StopDepartureSchema).default([]),
});

const GraphQlErrorSchema = z.object({
  message: z.string().nullable().default(null),
});

const EnturPlaceSchema = z.object({
  name: z.string().nullable().default(null),
});

const TripLegSchema = z.object({
  mode: z.string().nullable().default(null),
  aimedStartTime: z.string().nullable().default(null),
  aimedEndTime: z.string().nullable().default(null),
  expectedStartTime: z.string().nullable().default(null),
  expectedEndTime: z.string().nullable().default(null),
  line: EnturLineSchema.nullable().default(null),
  fromPlace: EnturPlaceSchema.nullable().default(null),
  toPlace: EnturPlaceSchema.nullable().default(null),
});

const TripPatternSchema = z.object({
  legs: z.array(TripLegSchema).default([]),
});

const EnturTripEnvelopeSchema = z.object({
  data: z
    .object({
      trip: z
        .object({ tripPatterns: z.array(TripPatternSchema).default([]) })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  errors: z.array(GraphQlErrorSchema).default([]),
});

/**
 * `stopPlace(id:)` 对不存在/已退役的站点 id 返回 `null` 而不是报错（实测
 * `{"data":{"stop0":null}}`），NSR 退役旧 id 时就是这种情况。值必须可空，
 * 否则一个站点失效会让整次解码失败，另一端正常的班次也一起看不到。
 */
const StopsEnvelopeSchema = z.object({
  data: z.record(z.string(), StopPlaceDataSchema.nullable()).nullable().default(null),
  errors: z.array(GraphQlErrorSchema).default([]),
});

const GeocoderEnvelopeSchema = z.object({
  features: z
    .array(
      z.object({
        geometry: z
          .object({ coordinates: z.array(z.number()).default([]) })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

/** 行程中的铁路段（已过滤步行换乘段）。 */
export interface TripRailLeg {
  line: string;
  depTime: Date;
  arrTime: Date;
  fromName: string;
  toName: string;
}

export interface TripItinerary {
  railLegs: TripRailLeg[];
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

// exactOptionalPropertyTypes 下不能把 `signal: undefined` 直接塞进带可选 signal 字段
// 的对象字面量；这里按是否传入 signal 分别构造，保持 FetchJsonOptions 的可选语义。
function requestOptions(signal: AbortSignal | undefined): FetchJsonOptions {
  const options: FetchJsonOptions = { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (signal) options.signal = signal;
  return options;
}

function parseOrFail<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SourceFailure("parse_error", `Entur 响应解析失败（${context}）：${result.error.message}`);
  }
  return result.data;
}

async function postGraphQl<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const { body } = await fetchJson<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": CLIENT_NAME },
      body: JSON.stringify({ query, variables }),
    },
    requestOptions(signal),
  );
  return body;
}

/**
 * 行程查询文本：全部入参都走 variables，查询文本是常量——不管调用方传什么值，
 * 都只能当数据用，不能改变查询结构（见 Kotlin 源码同一处的注入风险说明）。
 */
const FASTEST_TRIP_QUERY = `query Trip($from: String!, $to: String!, $at: DateTime!) {
  trip(
    from: { place: $from }
    to: { place: $to }
    dateTime: $at
    arriveBy: false
    modes: { transportModes: [{ transportMode: rail }] }
    numTripPatterns: 3
  ) {
    tripPatterns {
      legs {
        mode
        aimedStartTime
        aimedEndTime
        expectedStartTime
        expectedEndTime
        line { publicCode }
        fromPlace { name }
        toPlace { name }
      }
    }
  }
}`;

/**
 * 查询 from → to 最早到达的铁路行程（可含换乘）。
 *
 * @returns null 表示无结果（所有 tripPattern 都不含可用的铁路腿）
 */
export async function fastestTrip(
  fromStopId: string,
  toStopId: string,
  at: Date,
  signal?: AbortSignal,
): Promise<TripItinerary | null> {
  // GraphQL DateTime 只关心时间点，Date.toISOString() 的 "Z" 偏移与 Kotlin 端
  // ZonedDateTime 具体用哪个时区格式化等价（同一瞬间，偏移只是表示法，不改变语义）。
  const variables = { from: fromStopId, to: toStopId, at: at.toISOString() };
  const raw = await postGraphQl<unknown>(JOURNEY_PLANNER_URL, FASTEST_TRIP_QUERY, variables, signal);
  const envelope = parseOrFail(EnturTripEnvelopeSchema, raw, "fastestTrip");
  if (envelope.errors.length > 0) {
    // Entur 用 HTTP 200 + errors 数组表达查询级错误（多为非法站点 id），语义上
    // 更接近「我们发的请求有问题」而非上游故障，归为 upstream_4xx。
    throw new SourceFailure(
      "upstream_4xx",
      `Entur 行程查询失败：${envelope.errors.map((e) => e.message ?? "").join("；")}`,
    );
  }
  const patterns = envelope.data?.trip?.tripPatterns ?? [];
  for (const pattern of patterns) {
    const railLegs: TripRailLeg[] = [];
    for (const leg of pattern.legs) {
      if (leg.mode !== "rail") continue;
      const depIso = leg.expectedStartTime ?? leg.aimedStartTime;
      const arrIso = leg.expectedEndTime ?? leg.aimedEndTime;
      if (!depIso || !arrIso) continue;
      const depTime = new Date(depIso);
      const arrTime = new Date(arrIso);
      if (Number.isNaN(depTime.getTime()) || Number.isNaN(arrTime.getTime())) continue;
      railLegs.push({
        line: leg.line?.publicCode ?? "",
        depTime,
        arrTime,
        fromName: leg.fromPlace?.name ?? "",
        toName: leg.toPlace?.name ?? "",
      });
    }
    // 挑第一个「过滤出至少一段铁路腿」的 tripPattern，跳过全步行的候选。
    if (railLegs.length > 0) return { railLegs };
  }
  return null;
}

// ---------------------------------------------------------------------
// geocodeAddress：地址 → 坐标，带有界内存缓存。
// ---------------------------------------------------------------------

/** 与 Kotlin 端一致的缓存上限；缓存放模块级（天气/路况两个任务共享）。 */
const GEOCODE_CACHE_MAX = 64;
const geocodeCache = new Map<string, GeoPoint>();

/**
 * Java `URLEncoder.encode(_, "UTF-8")`（application/x-www-form-urlencoded）风格编码：
 * 空格编码为 "+" 而非 "%20"，字母数字和 `* - . _` 之外的字符统一走百分号编码。
 * `encodeURIComponent` 默认对 `! ' ( ) ~` 不转义，这里补上，其余字符两者行为一致。
 */
function formUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * 用 Entur 地理编码（免费，覆盖挪威地址）把地址转成 (纬度, 经度)，失败返回 null。
 *
 * 与源码一致：失败（HTTP 错误、JSON 解析失败、无结果）一律静默返回 null，不抛异常，
 * 不缓存失败结果（下次刷新会重试）；只有成功结果入缓存，缓存达上限时整体清空。
 */
export async function geocodeAddress(address: string, signal?: AbortSignal): Promise<GeoPoint | null> {
  const cached = geocodeCache.get(address);
  if (cached) return cached;
  const resolved = await fetchGeocode(address, signal);
  if (!resolved) return null;
  if (geocodeCache.size >= GEOCODE_CACHE_MAX) geocodeCache.clear();
  geocodeCache.set(address, resolved);
  return resolved;
}

async function fetchGeocode(address: string, signal?: AbortSignal): Promise<GeoPoint | null> {
  const url = `${GEOCODER_URL}?q=${formUrlEncode(address)}&lang=no`;
  let raw: unknown;
  try {
    const { body } = await fetchJson<unknown>(
      url,
      { headers: { "ET-Client-Name": CLIENT_NAME } },
      requestOptions(signal),
    );
    raw = body;
  } catch (err) {
    // 只在「确实拿到了上游响应」（status 有值，即 4xx/5xx）或响应体解析失败
    // （parse_error）时静默当成「查无结果」——这两种是上游明确给出的结果。网络错误、
    // 超时等「请求压根没打通」的失败必须重新抛出，让调用方（天气/路况任务）当成本次
    // 刷新失败处理，不能悄悄退化成「地址查不到」（见 CONTRACT 第 3 节「F2」）。
    if (err instanceof SourceFailure && (err.status !== undefined || err.code === "parse_error")) {
      return null;
    }
    throw err;
  }
  const parsed = GeocoderEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const coords = parsed.data.features[0]?.geometry?.coordinates;
  if (!coords) return null;
  // GeoJSON coordinates 是 [lon, lat]；对外返回 (lat, lon)。
  const [lon, lat] = coords;
  if (lon === undefined || lat === undefined) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------------
// fetchStop / fetchBoth：完整站点块（含每班次全程站点，供换乘配对用）。
// ---------------------------------------------------------------------

/** GraphQL 别名/变量名合法形式：不以数字开头的字母/数字/下划线。 */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fullStopBlock(alias: string): string {
  return `  ${alias}: stopPlace(id: $stop_${alias}) {
    name
    estimatedCalls(startTime: $start_${alias}, timeRange: $range, numberOfDepartures: $calls) {
      realtime
      aimedDepartureTime
      expectedDepartureTime
      cancellation
      destinationDisplay { frontText }
      serviceJourney {
        transportMode
        journeyPattern { line { publicCode } }
        estimatedCalls { quay { name } aimedArrivalTime expectedArrivalTime }
      }
    }
  }`;
}

interface StopQuery {
  stopId: string;
  from: Date;
}

async function queryStops(
  aliases: Map<string, StopQuery>,
  rangeMinutes: number,
  maxCalls: number,
  signal?: AbortSignal,
): Promise<Map<string, StopDeparture[]>> {
  const aliasNames = [...aliases.keys()];
  // 别名会作为 GraphQL 字段名出现在查询文本里（别名不能是变量）；当前调用点全部
  // 用常量别名（stopA/stopB），校验只是为将来接入动态别名时留一道保险。
  for (const alias of aliasNames) {
    if (!GRAPHQL_NAME.test(alias)) throw new Error(`非法 GraphQL 别名：${alias}`);
  }
  const query = `query Departures(${aliasNames
    .map((alias) => `$stop_${alias}: String!, $start_${alias}: DateTime`)
    .join(", ")}, $range: Int!, $calls: Int!) {
${aliasNames.map((alias) => fullStopBlock(alias)).join("\n")}
}`;
  const variables: Record<string, unknown> = {
    range: rangeMinutes * 60,
    calls: maxCalls,
  };
  for (const [alias, { stopId, from }] of aliases) {
    variables[`stop_${alias}`] = stopId;
    variables[`start_${alias}`] = from.toISOString();
  }
  const raw = await postGraphQl<unknown>(JOURNEY_PLANNER_URL, query, variables, signal);
  const envelope = parseOrFail(StopsEnvelopeSchema, raw, "queryStops");
  if (envelope.errors.length > 0) {
    throw new SourceFailure(
      "upstream_4xx",
      `Entur 班次查询失败：${envelope.errors.map((e) => e.message ?? "").join("；")}`,
    );
  }
  const data = envelope.data ?? {};
  const result = new Map<string, StopDeparture[]>();
  for (const alias of aliasNames) {
    // 站点缺失或显式为 null（退役 id）都按「没有班次」处理，不当解析失败。
    result.set(alias, data[alias]?.estimatedCalls ?? []);
  }
  return result;
}

export interface QueryOptions {
  rangeMinutes?: number;
  maxCalls?: number;
  signal?: AbortSignal;
}

/** 查询单个站点的未来班次（含线路、方向与每班次全程各站到达时刻），供换乘面板用。 */
export async function fetchStop(stopId: string, from: Date, options: QueryOptions = {}): Promise<StopDeparture[]> {
  const result = await queryStops(
    new Map([["stopA", { stopId, from }]]),
    options.rangeMinutes ?? 180,
    options.maxCalls ?? 120,
    options.signal,
  );
  return result.get("stopA") ?? [];
}

export async function fetchBoth(
  stopAId: string,
  stopBId: string,
  fromA: Date,
  fromB: Date,
  options: QueryOptions = {},
): Promise<[StopDeparture[], StopDeparture[]]> {
  const result = await queryStops(
    new Map([
      ["stopA", { stopId: stopAId, from: fromA }],
      ["stopB", { stopId: stopBId, from: fromB }],
    ]),
    options.rangeMinutes ?? 180,
    options.maxCalls ?? 120,
    options.signal,
  );
  return [result.get("stopA") ?? [], result.get("stopB") ?? []];
}

// ---------------------------------------------------------------------
// fetchStopDepartures：轻量查询（首页关注线路卡片用），不拉每班次全程站点。
// ---------------------------------------------------------------------

function lightStopBlock(index: number): string {
  return `  stop${index}: stopPlace(id: $stop${index}) {
    name
    estimatedCalls(startTime: $start, timeRange: $range, numberOfDepartures: $calls) {
      realtime
      aimedDepartureTime
      expectedDepartureTime
      cancellation
      destinationDisplay { frontText }
      serviceJourney { transportMode journeyPattern { line { publicCode } } }
    }
  }`;
}

/**
 * 查询若干站点的未来班次，只取线路号与发车时刻（不取每班次全程站点，数据量约
 * 是完整版本的 1/20，见 Kotlin 源码同名函数注释）。
 *
 * @returns 以 stopIds 中实际返回数据的站点为键的 Map；站点缺失或 Entur 返回
 *   null（退役 id）时不在结果里，调用方按「没有班次」处理。
 */
export async function fetchStopDepartures(
  stopIds: string[],
  from: Date,
  options: QueryOptions = {},
): Promise<Map<string, StopDeparture[]>> {
  if (stopIds.length === 0) return new Map();
  const rangeMinutes = options.rangeMinutes ?? 180;
  const maxCalls = options.maxCalls ?? 200;
  const query = `query Departures(${stopIds
    .map((_, index) => `$stop${index}: String!`)
    .join(", ")}, $start: DateTime, $range: Int!, $calls: Int!) {
${stopIds.map((_, index) => lightStopBlock(index)).join("\n")}
}`;
  const variables: Record<string, unknown> = {
    start: from.toISOString(),
    range: rangeMinutes * 60,
    calls: maxCalls,
  };
  stopIds.forEach((id, index) => {
    variables[`stop${index}`] = id;
  });
  const raw = await postGraphQl<unknown>(JOURNEY_PLANNER_URL, query, variables, options.signal);
  const envelope = parseOrFail(StopsEnvelopeSchema, raw, "fetchStopDepartures");
  if (envelope.errors.length > 0) {
    throw new SourceFailure(
      "upstream_4xx",
      `Entur 班次查询失败：${envelope.errors.map((e) => e.message ?? "").join("；")}`,
    );
  }
  const data = envelope.data ?? {};
  const result = new Map<string, StopDeparture[]>();
  stopIds.forEach((id, index) => {
    const place = data[`stop${index}`];
    if (place) result.set(id, place.estimatedCalls);
  });
  return result;
}

// ---------------------------------------------------------------------
// fetchWatchedLineDepartures：[gate] P9 关注线路卡片用的查询（bus 任务用它）。
// 早期版本曾有一个只按线路号白名单过滤、不取站序的变体（`fetchStopDeparturesForLines`），
// T9.5 起已删除（T9.3 之后已无人调用）。与那个变体的区别：line 白名单只传一个
// （关注线路只有一条），并且每班次额外取 serviceJourney.quays
// { stopPlace { id parent { id } } }（该班次按顺序经过的 stop place，含各自的父站 id）——
// CONTRACT 第 9 节的方向判定靠站序而不是终点文案，需要这份数据；parent 是 [gate] P10
// 修正：估计到站给出的常是子 stop place（如站台），设置里存的可能是父站 id（多模式枢纽），
// 缺 parent 时按 null 处理，只比 id。bff/scripts/probe-entur-lines.mjs 已在本机验证
// serviceJourney.quays 字段存在。
// ---------------------------------------------------------------------

// [gate] P10 修正：parent 是该子站所属的父 stop place（多模式枢纽没有父站时为 null），
// 与 CONTRACT 第 9 节「站的匹配」对应——设置里存的可能是父站 id，方向判定要能认出子站。
const WatchedLineQuaySchema = z.object({
  stopPlace: z
    .object({
      id: z.string().nullable().default(null),
      parent: z.object({ id: z.string().nullable().default(null) }).nullable().default(null),
    })
    .nullable()
    .default(null),
});

const WatchedLineServiceJourneySchema = z.object({
  transportMode: z.string().nullable().default(null),
  journeyPattern: EnturJourneyPatternSchema.nullable().default(null),
  quays: z.array(WatchedLineQuaySchema).default([]),
});

export const WatchedLineStopDepartureSchema = z.object({
  realtime: z.boolean().default(false),
  aimedDepartureTime: z.string().nullable().default(null),
  expectedDepartureTime: z.string().nullable().default(null),
  cancellation: z.boolean().default(false),
  destinationDisplay: DestinationDisplaySchema.nullable().default(null),
  serviceJourney: WatchedLineServiceJourneySchema.nullable().default(null),
});
export type WatchedLineStopDeparture = z.infer<typeof WatchedLineStopDepartureSchema>;

const WatchedLineStopPlaceDataSchema = z.object({
  name: z.string().nullable().default(null),
  estimatedCalls: z.array(WatchedLineStopDepartureSchema).default([]),
});

const WatchedLineStopsEnvelopeSchema = z.object({
  data: z.record(z.string(), WatchedLineStopPlaceDataSchema.nullable()).nullable().default(null),
  errors: z.array(GraphQlErrorSchema).default([]),
});

function watchedLineStopBlock(index: number): string {
  return `  stop${index}: stopPlace(id: $stop${index}) {
    name
    estimatedCalls(
      startTime: $start
      timeRange: $range
      numberOfDepartures: $calls
      whiteListed: { lines: $lines }
    ) {
      realtime
      aimedDepartureTime
      expectedDepartureTime
      cancellation
      destinationDisplay { frontText }
      serviceJourney {
        transportMode
        journeyPattern { line { publicCode } }
        quays { stopPlace { id parent { id } } }
      }
    }
  }`;
}

/**
 * 查询若干站点、服务端已按单条线路 id 过滤的未来班次，并带上每班次的站序（quays）。
 *
 * @returns 以 stopIds 中实际返回数据的站点为键的 Map；站点缺失或 Entur 返回
 *   null（退役 id）时不在结果里，调用方按「没有班次」处理。
 */
export async function fetchWatchedLineDepartures(
  stopIds: string[],
  lineId: string,
  from: Date,
  options: QueryOptions = {},
): Promise<Map<string, WatchedLineStopDeparture[]>> {
  if (stopIds.length === 0) return new Map();
  const rangeMinutes = options.rangeMinutes ?? 180;
  const maxCalls = options.maxCalls ?? 50;
  const query = `query Departures(${stopIds
    .map((_, index) => `$stop${index}: String!`)
    .join(", ")}, $start: DateTime, $range: Int!, $calls: Int!, $lines: [ID]) {
${stopIds.map((_, index) => watchedLineStopBlock(index)).join("\n")}
}`;
  const variables: Record<string, unknown> = {
    start: from.toISOString(),
    range: rangeMinutes * 60,
    calls: maxCalls,
    lines: [lineId],
  };
  stopIds.forEach((id, index) => {
    variables[`stop${index}`] = id;
  });
  const raw = await postGraphQl<unknown>(JOURNEY_PLANNER_URL, query, variables, options.signal);
  const envelope = parseOrFail(WatchedLineStopsEnvelopeSchema, raw, "fetchWatchedLineDepartures");
  if (envelope.errors.length > 0) {
    throw new SourceFailure(
      "upstream_4xx",
      `Entur 班次查询失败：${envelope.errors.map((e) => e.message ?? "").join("；")}`,
    );
  }
  const data = envelope.data ?? {};
  const result = new Map<string, WatchedLineStopDeparture[]>();
  stopIds.forEach((id, index) => {
    const place = data[`stop${index}`];
    if (place) result.set(id, place.estimatedCalls);
  });
  return result;
}
