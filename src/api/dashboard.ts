// GET /v1/dashboard：从各来源快照组装 Dashboard（契约见 CONTRACT.md 第 3 节 dashboard 一行
// 与 src/contract/dashboard.ts）。信封的 configKey 约定见 bff/TASKS.md「P3 通用约定」：
// weather = trim(originAddress)；traffic_outbound = trim(origin)|trim(dest)，
// traffic_return 反之；bus = "<lineId>|<stopAId>|<stopBId>"（关注线路，[gate] P9）；
// football = "86"；train = trainConfigKey(settings)
// （回退后的站名，见 domain/l1-stations.ts，与 jobs/train.ts 写快照时用同一份逻辑）。
// configKey 不匹配或快照从未写入时，snapshot.get 返回 null，这里统一按 "not_configured" 呈现。
import { Hono } from "hono";
import { requireDevice, type AppVariables } from "../auth/middleware";
import { getSettingsRecord } from "../config/store";
import { DashboardSchema, type Dashboard } from "../contract/dashboard";
import type { Env } from "../env";
import { resolveWindow } from "../domain/windows";
import { configKeysFor } from "../snapshot/config-keys";
import * as snapshot from "../snapshot/store";

const dashboardApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

dashboardApi.use("*", requireDevice());

// 组装阶段的信封统一用 snapshot.SnapshotEnvelope（data: unknown）——具体来源的 data 形状
// 由 DashboardSchema.parse 在输出前做运行时校验，这里不需要（也难以干净地表达）逐来源的
// 静态类型。
const NOT_CONFIGURED_ENVELOPE: snapshot.SnapshotEnvelope = {
  state: "not_configured",
  fetchedAt: null,
  observedAt: null,
  error: null,
  data: null,
};

/**
 * 来源信封的不变式（CONTRACT.md 第 3 节）：state = "not_configured" 时 data 与 error
 * 均为 null；state = "ok" 时 error 为 null。这里在组装阶段强制执行一遍，不完全依赖
 * 各任务写快照时守规矩——防御性的最后一道保险，宁可在这里多判一次，也不要让某个
 * 任务的疏漏直接泄到 App 那一侧。
 */
function enforceEnvelopeInvariants(envelope: snapshot.SnapshotEnvelope): snapshot.SnapshotEnvelope {
  if (envelope.state === "not_configured") {
    return { ...envelope, data: null, error: null };
  }
  if (envelope.state === "ok" && envelope.error !== null) {
    return { ...envelope, error: null };
  }
  return envelope;
}

async function envelopeFor(env: Env, source: string, configKey: string | null): Promise<snapshot.SnapshotEnvelope> {
  const snap = await snapshot.get(env, source, configKey);
  return enforceEnvelopeInvariants(snap ?? NOT_CONFIGURED_ENVELOPE);
}

/**
 * CONTRACT.md 第 3 节「GET /v1/dashboard 的 ETag」：对 DashboardSchema.parse 之后、
 * 去掉 generatedAt 的对象做 JSON.stringify（键序以 schema 为准），取 SHA-256 的前 16 位
 * hex，加双引号，作为强 ETag。generatedAt 每次请求都不同（= now.toISOString()），
 * 必须排除在外，否则 ETag 永远不会重复命中（settingsRevision / window 或任一来源信封
 * 变化都必须改变 ETag，只有 generatedAt 不同视为未变化）。
 */
async function etagOf(dashboard: Dashboard): Promise<string> {
  const { generatedAt: _generatedAt, ...rest } = dashboard;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rest)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 16)}"`;
}

/**
 * RFC 9110 If-None-Match：逗号分隔的 ETag 列表，比较时忽略 `W/` 弱校验前缀，
 * `*` 匹配任意值。
 */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((raw) => {
    const candidate = raw.trim();
    const stripped = candidate.startsWith("W/") ? candidate.slice(2) : candidate;
    return stripped === etag;
  });
}

dashboardApi.get("/", async (c) => {
  const env = c.env;
  const now = new Date();
  const record = await getSettingsRecord(env);
  const settings = record.settings;

  const keys = configKeysFor(settings);

  const [weather, train, trafficOutbound, trafficReturn, bus, football] = await Promise.all([
    envelopeFor(env, "weather", keys.weather),
    envelopeFor(env, "train", keys.train),
    envelopeFor(env, "traffic_outbound", keys.traffic_outbound),
    envelopeFor(env, "traffic_return", keys.traffic_return),
    envelopeFor(env, "bus", keys.bus),
    envelopeFor(env, "football", keys.football),
  ]);

  const dashboard: unknown = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    settingsRevision: record.revision,
    window: resolveWindow(now, settings),
    sources: { weather, train, trafficOutbound, trafficReturn, bus, football },
  };

  // 输出前自检：DashboardSchema.parse 失败说明组装出的信封与契约不符，宁可 500 也不能
  // 把不合规的响应发给 App。
  const checked: Dashboard = DashboardSchema.parse(dashboard);
  const etag = await etagOf(checked);

  const ifNoneMatch = c.req.header("If-None-Match");
  c.header("ETag", etag);
  if (ifNoneMatchHits(ifNoneMatch, etag)) {
    return c.body(null, 304);
  }
  return c.body(JSON.stringify(checked), 200, { "Content-Type": "application/json" });
});

export default dashboardApi;
