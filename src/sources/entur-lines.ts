// GET /v1/lines 的数据源：一次 Entur 查询取两个 stop place 沿线的线路（quays.lines），
// 返回两边都出现的线路，供 App 与管理界面在选定两个站之后列出可选线路（CONTRACT 第 9 节）。
//
// 与 src/sources/entur.ts 里到站查询不同的用途，独立成文件（卡上只允许新建
// src/sources/entur-lines.ts，不修改 entur.ts 之外的既有函数）；bff/scripts/probe-entur-lines.mjs
// 已在本机验证 stopPlace.quays.lines 字段存在。
import { z } from "zod";
import type { Line } from "../contract/lines";
import { fetchJson } from "./http";

const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";

// 与 entur.ts 保持一致：BFF 是独立客户端，用自己的名字上报 Entur。
const CLIENT_NAME = "personal-assistant-bff";

const DEFAULT_TIMEOUT_MS = 8000;

const LineRefSchema = z.object({
  id: z.string().nullable().default(null),
  publicCode: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  transportMode: z.string().nullable().default(null),
});

const QuaySchema = z.object({
  lines: z.array(LineRefSchema).default([]),
});

const StopPlaceLinesSchema = z.object({
  quays: z.array(QuaySchema).nullable().default(null),
});

const LinesEnvelopeSchema = z.object({
  data: z
    .object({
      stopA: StopPlaceLinesSchema.nullable().default(null),
      stopB: StopPlaceLinesSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
  errors: z.array(z.object({ message: z.string().nullable().default(null) })).default([]),
});

const QUERY = `query Lines($stopA: String!, $stopB: String!) {
  stopA: stopPlace(id: $stopA) {
    quays {
      lines { id publicCode name transportMode }
    }
  }
  stopB: stopPlace(id: $stopB) {
    quays {
      lines { id publicCode name transportMode }
    }
  }
}`;

/** 某个 stop place 沿线全部线路 id 去重后的集合与首次出现的完整数据。 */
function linesOf(stop: z.infer<typeof StopPlaceLinesSchema> | null): Map<string, Line> {
  const result = new Map<string, Line>();
  for (const quay of stop?.quays ?? []) {
    for (const line of quay.lines) {
      if (!line.id || result.has(line.id)) continue;
      result.set(line.id, {
        id: line.id,
        publicCode: line.publicCode ?? "",
        name: line.name ?? "",
        transportMode: line.transportMode ?? "",
      });
    }
  }
  return result;
}

/**
 * 排序：先按 transportMode 字典序，再按 publicCode ——两边都能解析成数字时按数值比较
 * （例如 "9" 排在 "42" 前面），否则按字符串比较（见 contract/lines.ts LinesResponseSchema 注释）。
 */
function compareLines(a: Line, b: Line): number {
  if (a.transportMode !== b.transportMode) return a.transportMode < b.transportMode ? -1 : 1;
  const na = Number(a.publicCode);
  const nb = Number(b.publicCode);
  if (a.publicCode !== "" && b.publicCode !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    if (na !== nb) return na - nb;
  } else if (a.publicCode !== b.publicCode) {
    return a.publicCode < b.publicCode ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 查询两个 stop place 都出现的线路（按 id 去重），任一 stop place 不存在时返回空列表。
 * 上游失败（超时/4xx/5xx/parse_error/查询级 errors）原样抛出，交给调用方决定 502 upstream_error。
 */
export async function fetchCommonLines(stopAId: string, stopBId: string, signal?: AbortSignal): Promise<Line[]> {
  const options: { signal?: AbortSignal; timeoutMs: number } = { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (signal) options.signal = signal;

  const { body } = await fetchJson<unknown>(
    JOURNEY_PLANNER_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": CLIENT_NAME },
      body: JSON.stringify({ query: QUERY, variables: { stopA: stopAId, stopB: stopBId } }),
    },
    options,
  );

  const parsed = LinesEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Entur 线路响应解析失败：${parsed.error.message}`);
  }
  const envelope = parsed.data;
  if (envelope.errors.length > 0) {
    throw new Error(`Entur 线路查询失败：${envelope.errors.map((e) => e.message ?? "").join("；")}`);
  }

  const linesA = linesOf(envelope.data?.stopA ?? null);
  const linesB = linesOf(envelope.data?.stopB ?? null);

  const common: Line[] = [];
  for (const [id, line] of linesA) {
    if (linesB.has(id)) common.push(line);
  }
  common.sort(compareLines);
  return common;
}
