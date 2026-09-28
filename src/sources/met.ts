// 从 app/.../data/met/MetApi.kt 移植。字段与请求形状逐一对应，见各处注释标出差异。
//
// F5：改用 src/sources/http.ts 的 fetchJson（带 passStatuses: [304]），不再自己重新
// 实现一遍「发请求 + 归类错误」——原先这里单独维护的超时判定（只认 name==="AbortError"）
// 和 http.ts 已经修过的问题（F1）不同步，会漏判 TimeoutError 之类的中止原因。
import { z } from "zod";
import { fetchJson, SourceFailure } from "./http";

const DEFAULT_BASE_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

// BFF 是独立客户端，User-Agent 按 CONTRACT.md 约定的格式给自己的标识，
// 不能沿用 App 端的 UA（MET 用 UA 做联系方式/限流统计）。
const USER_AGENT = "personal-assistant-bff/1.0 (cloudflare-worker, personal use)";

const DEFAULT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------
// 响应形状：与 MetApi.kt 的 @Serializable data class 逐一对应，未知字段忽略
// （z.object 默认 strip），缺字段给默认值，解析失败统一归为 parse_error。
// ---------------------------------------------------------------------

const MetDetailsSchema = z.object({
  air_temperature: z.number().default(0),
  wind_speed: z.number().default(0),
  wind_from_direction: z.number().default(0),
  precipitation_amount: z.number().default(0),
});

const MetInstantSchema = z.object({
  details: MetDetailsSchema.nullable().default(null),
});

const MetSummarySchema = z.object({
  symbol_code: z.string().default(""),
});

const MetNextDetailsSchema = z.object({
  precipitation_amount: z.number().default(0),
});

const MetNextSchema = z.object({
  summary: MetSummarySchema.nullable().default(null),
  details: MetNextDetailsSchema.nullable().default(null),
});

const MetDataSchema = z.object({
  instant: MetInstantSchema.nullable().default(null),
  next_1_hours: MetNextSchema.nullable().default(null),
  next_6_hours: MetNextSchema.nullable().default(null),
});

const MetTimePointSchema = z.object({
  time: z.string().default(""),
  data: MetDataSchema.nullable().default(null),
});

const MetPropertiesSchema = z.object({
  timeseries: z.array(MetTimePointSchema).default([]),
});

const MetEnvelopeSchema = z.object({
  properties: MetPropertiesSchema.nullable().default(null),
});

export type MetData = z.infer<typeof MetDataSchema>;
export type MetTimePoint = z.infer<typeof MetTimePointSchema>;
export type MetEnvelope = z.infer<typeof MetEnvelopeSchema>;

/**
 * Java `"%.4f".format(Locale.US, x)` 风格格式化：按该 double 的「最短可还原十进制表示」
 * （即 `Double.toString()` / JS `Number.prototype.toString()` 给出的字符串，两者用的是
 * 同一类最短往返算法）四舍五入到 4 位小数，而不是按该数在内存里的精确二进制值四舍五入。
 *
 * 两者的差别只在极少数「十进制表示恰好落在第 5 位是 5」的边界值上才会显现：例如
 * `10.75235` 的精确二进制值其实略小于十进制 10.75235（约 10.752349999999999852），
 * 若按精确值四舍五入会得到 10.7523；但 Java 的 `Formatter` 内部是先转成
 * `new BigDecimal(Double.toString(x))`（= 精确的十进制串 "10.75235"）再四舍五入，
 * 结果是 10.7524。这里照抄同一条路径，而不是直接用 `toFixed`（后者按精确二进制值
 * 舍入，会在这类边界上与 Kotlin 侧的记录测试对不上）。
 */
export function formatCoordinate(value: number): string {
  const sign = value < 0 ? "-" : "";
  const decimalString = Math.abs(value).toString();
  if (decimalString.includes("e") || decimalString.includes("E")) {
    // lat/lon 取值范围（-180..180）内不会走到这条分支；留一个保守兜底。
    return `${sign}${Math.abs(value).toFixed(4)}`;
  }
  const [intPart = "0", fracPartRaw = ""] = decimalString.split(".");
  const padded = (fracPartRaw + "00000").slice(0, 5);
  const keep = padded.slice(0, 4);
  const roundUp = Number(padded[4]) >= 5;
  let fracNum = BigInt(keep === "" ? "0" : keep);
  let intNum = BigInt(intPart);
  if (roundUp) {
    fracNum += 1n;
    if (fracNum >= 10000n) {
      fracNum -= 10000n;
      intNum += 1n;
    }
  }
  return `${sign}${intNum.toString()}.${fracNum.toString().padStart(4, "0")}`;
}

export interface FetchWeatherOptions {
  /** 上次快照的 Last-Modified，带上后命中未变化时上游应返回 304。 */
  ifModifiedSince?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface FetchWeatherResult {
  /** true 表示 304：调用方应保留旧数据，只动 fetched_at（见 snapshot/store.ts 的 putNotModified）。 */
  notModified: boolean;
  /** notModified 为 true 时为 null。 */
  envelope: MetEnvelope | null;
  etag: string | null;
  lastModified: string | null;
  /** 响应头 Expires；调度器用它算 CadenceCtx.weatherExpiresAt。 */
  expires: string | null;
}

/** 请求 MET locationforecast/compact，lat/lon 按 formatCoordinate 格式化进 URL。 */
export async function fetchWeather(lat: number, lon: number, options: FetchWeatherOptions = {}): Promise<FetchWeatherResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}?lat=${formatCoordinate(lat)}&lon=${formatCoordinate(lon)}`;

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (options.ifModifiedSince) headers["If-Modified-Since"] = options.ifModifiedSince;

  const { status, headers: responseHeaders, body } = await fetchJson<unknown>(
    url,
    { headers },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      passStatuses: [304],
    },
  );

  const etag = responseHeaders.get("etag");
  const lastModified = responseHeaders.get("last-modified");
  const expires = responseHeaders.get("expires");

  if (status === 304) {
    return { notModified: true, envelope: null, etag, lastModified, expires };
  }

  const parsed = MetEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new SourceFailure("parse_error", `MET 天气响应解析失败：${parsed.error.message}`);
  }

  return { notModified: false, envelope: parsed.data, etag, lastModified, expires };
}
