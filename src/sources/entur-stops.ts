// GET /v1/stops/search 的数据源：调用 Entur 地理编码 autocomplete，只保留车站
// （id 以 NSR:StopPlace: 开头的结果），供设置页的站点选择器用。
//
// 与 src/sources/entur.ts 里 geocodeAddress 的用途不同（那个是「地址 → 坐标」，
// 单一结果、带缓存），这里要多条候选，不缓存（搜索词几乎不重复，缓存收益低）。
import { z } from "zod";
import { fetchJson } from "./http";

const GEOCODER_URL = "https://api.entur.io/geocoder/v3/autocomplete";

// 与 entur.ts 保持一致：BFF 是独立客户端，用自己的名字上报 Entur。
const CLIENT_NAME = "personal-assistant-bff";

const DEFAULT_TIMEOUT_MS = 8000;

/** 站点 id 前缀；autocomplete 在 layers=venue 下也可能混入非车站的场所结果，需要再过滤一次。 */
const STOP_ID_PREFIX = "NSR:StopPlace:";

/** 契约里一次最多返回 10 条候选（见 CONTRACT.md 第 3 节 stops/search 一行）。 */
const MAX_RESULTS = 10;

const StopFeaturePropertiesSchema = z.object({
  id: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  locality: z.string().nullable().default(null),
});

const StopFeatureSchema = z.object({
  properties: StopFeaturePropertiesSchema.nullable().default(null),
});

const StopSearchEnvelopeSchema = z.object({
  features: z.array(StopFeatureSchema).default([]),
});

export interface StopSearchResult {
  id: string;
  name: string;
  locality: string | null;
}

/**
 * 按用户输入的搜索词查候选车站。调用方（src/api/stops.ts）已校验 q 长度在 2..60，
 * 这里不重复校验；上游失败（超时/4xx/5xx/parse_error）原样抛出 SourceFailure，
 * 交给全局错误处理落成 500 internal_error（契约没有为这个接口定义专门的上游错误码）。
 */
export async function searchStops(query: string, signal?: AbortSignal): Promise<StopSearchResult[]> {
  const url = `${GEOCODER_URL}?text=${encodeURIComponent(query)}&layers=venue&lang=no`;
  const options: { signal?: AbortSignal; timeoutMs: number } = { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (signal) options.signal = signal;

  const { body } = await fetchJson<unknown>(url, { headers: { "ET-Client-Name": CLIENT_NAME } }, options);

  const parsed = StopSearchEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    // 响应形状意外时按「无结果」处理而不是抛 parse_error：搜索接口返回空列表
    // 比报错更符合用户预期（用户可以继续改词重搜）。
    return [];
  }

  const results: StopSearchResult[] = [];
  for (const feature of parsed.data.features) {
    const props = feature.properties;
    if (!props?.id || !props.name) continue;
    if (!props.id.startsWith(STOP_ID_PREFIX)) continue;
    results.push({ id: props.id, name: props.name, locality: props.locality });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}
