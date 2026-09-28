// 从 app/.../data/google/GoogleRoutesApi.kt 移植：Google Routes computeRoutes 端点的
// 请求构造与响应解析。统一走 src/sources/http.ts 的 fetchJson（P3 通用约定），因此这里
// 不再区分 Kotlin 源码里 403/400/其它状态码各自不同的错误文案——fetchJson 已经把非 2xx
// 归到 upstream_4xx / upstream_5xx 两类（契约 SourceErrorSchema.code 的取值），文案统一
// 由 fetchJson 生成，不影响 error.code 的分类（putFailure 只依赖 code）。
import { z } from "zod";
import { fetchJson, SourceFailure, type FetchJsonOptions } from "./http";
import { osloIsoOffset } from "../util/time";

export const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

// 单次请求超时：与 entur.ts 的 DEFAULT_TIMEOUT_MS 一致，tick 的墙钟预算有限。
const DEFAULT_TIMEOUT_MS = 8000;

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RouteInfo {
  duration: string;
  staticDuration: string;
  distanceMeters: number;
}

const RouteInfoSchema = z.object({
  duration: z.string().default(""),
  staticDuration: z.string().default(""),
  distanceMeters: z.number().default(0),
});

const RoutesEnvelopeSchema = z.object({
  routes: z.array(RouteInfoSchema).default([]),
});

export interface ComputeRouteParams {
  apiKey: string;
  origin: string;
  destination: string;
  /** 优先用经纬度（避免地址地理编码失败导致 400）；为空时退回地址，与 Kotlin 版一致。 */
  originLatLng?: GeoPoint | null;
  destLatLng?: GeoPoint | null;
  /** 应为未来时间（TRAFFIC_AWARE 要求），调用方负责提前。 */
  departureTime: Date;
  signal?: AbortSignal;
  /** 测试用：替换请求端点。 */
  baseUrl?: string;
}

function locationBody(point: GeoPoint | null | undefined, address: string): Record<string, unknown> {
  if (point) {
    return { location: { latLng: { latitude: point.lat, longitude: point.lon } } };
  }
  return { address };
}

/**
 * 请求 Google Routes computeRoutes，取第一条路线。
 *
 * apiKey 为空白时提前拒绝，不发请求（与 Kotlin `compute()` 的 blank 校验一致）；
 * 正常情况下调用方（traffic 任务）应先用 getSecretPlain 判断密钥是否存在，缺失时
 * 直接 putState(not_configured)，不会走到这里——这里的校验是最后一道保险。
 */
export async function computeRoute(params: ComputeRouteParams): Promise<RouteInfo> {
  if (!params.apiKey.trim()) {
    throw new SourceFailure("upstream_4xx", "未配置 Google Maps API Key");
  }

  const payload = {
    origin: locationBody(params.originLatLng, params.origin),
    destination: locationBody(params.destLatLng, params.destination),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    // withNano(0) 抹掉纳秒/毫秒；osloIsoOffset 已是秒精度，与 Kotlin 版对齐，不手写偏移。
    departureTime: osloIsoOffset(params.departureTime),
    units: "METRIC",
    languageCode: "zh-CN",
  };

  const options: FetchJsonOptions = { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (params.signal) options.signal = params.signal;

  const { body } = await fetchJson<unknown>(
    params.baseUrl ?? ROUTES_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": params.apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
      },
      body: JSON.stringify(payload),
    },
    options,
  );

  const parsed = RoutesEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new SourceFailure("parse_error", `Google Routes 响应解析失败：${parsed.error.message}`);
  }
  const route = parsed.data.routes[0];
  if (!route) {
    // 结构合法但没有可用路线：不是网络/HTTP 故障，归为 parse_error（拿不到需要的数据）。
    throw new SourceFailure("parse_error", "Google 未返回路线");
  }
  return route;
}

/**
 * 解析 Google Routes 的 `duration`/`staticDuration`（protobuf Duration 的 JSON 形式）。
 *
 * 整数秒（"10500s"）是当前唯一观察到的形式，但该标量的规范允许小数（"10.5s"，纳秒非零
 * 时就是这种写法）。与 Kotlin 端 `TrafficRepository.parseSec` 一致：只用 `toLongOrNull`
 * 会把合法的小数响应静默当成 0 秒，因此用 parseFloat 兜底，解析失败也按 0 秒处理。
 */
export function parseDurationSeconds(value: string): number {
  const num = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}
