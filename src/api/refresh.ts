// POST /v1/refresh：把指定任务的 next_run_at 设为 now，供 App「手动刷新」按钮用。
// 契约见 CONTRACT.md 第 3 节 refresh 一行：body 里的 sources 用 dashboard 的来源键
// （weather/train/trafficOutbound/trafficReturn/bus/football），这里映射到调度器认识的
// 任务名（weather/train/traffic_outbound/traffic_return/bus/football）。
import { Hono } from "hono";
import { requireDevice, requireOwner, type AppVariables } from "../auth/middleware";
import type { SourceKey } from "../contract/dashboard";
import type { Env } from "../env";
import { apiError } from "../util/errors";

const refreshApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

refreshApi.use("*", requireDevice());

const ALL_SOURCE_KEYS: SourceKey[] = ["weather", "train", "trafficOutbound", "trafficReturn", "bus", "football"];

/** dashboard 来源键 -> 调度器任务名。 */
const JOB_NAME_OF: Partial<Record<SourceKey, string>> = {
  weather: "weather",
  train: "train",
  trafficOutbound: "traffic_outbound",
  trafficReturn: "traffic_return",
  bus: "bus",
  football: "football",
};

const THROTTLE_MS = 60_000;

function isSourceKey(value: unknown): value is SourceKey {
  return typeof value === "string" && (ALL_SOURCE_KEYS as string[]).includes(value);
}

/**
 * 每分钟最多一次的原子占用：INSERT ... ON CONFLICT DO UPDATE ... WHERE 把「距上次是否
 * 已过 60 秒」这个判断写进同一条 SQL——两个并发请求同时提交时，D1/SQLite 按事务顺序
 * 串行执行，只有先提交的那个真正更新到 meta.value，RETURNING 有行；后提交的那个因为
 * WHERE 条件不成立，UPDATE 不生效、也不会新插入（已存在同 key 行），RETURNING 无行。
 */
async function tryAcquireRefreshThrottle(env: Env, now: Date): Promise<boolean> {
  const nowMs = String(now.getTime());
  const earliestAllowedMs = String(now.getTime() - THROTTLE_MS);
  const row = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('refresh_last_at', ?1)
     ON CONFLICT(key) DO UPDATE SET value = ?1
     WHERE meta.value IS NULL OR CAST(meta.value AS INTEGER) <= ?2
     RETURNING value`,
  )
    .bind(nowMs, earliestAllowedMs)
    .first<{ value: string }>();
  return row !== null;
}

refreshApi.post("/", requireOwner(), async (c) => {
  const env = c.env;
  const now = new Date();

  const raw = await c.req.json().catch(() => ({}));
  const requestedRaw = (raw as { sources?: unknown } | null)?.sources;
  const requested: SourceKey[] = Array.isArray(requestedRaw)
    ? requestedRaw.filter(isSourceKey)
    : ALL_SOURCE_KEYS;

  const acquired = await tryAcquireRefreshThrottle(env, now);
  if (!acquired) {
    return apiError(c, 429, "too_soon", "刷新过于频繁，请一分钟后再试");
  }

  const jobNames = requested.map((key) => JOB_NAME_OF[key]).filter((name): name is string => Boolean(name));

  // F7：queued 只应该列出「实际把 next_run_at 设成功」的来源；某个来源有任务名但 jobs
  // 表里还没有那一行时（UPDATE 影响 0 行，理论上不该发生，seedJobs 会在每次 tick 播种
  // 所有已注册任务），防御性地按实际生效与否上报，不盲目回显 requested。
  let queued: SourceKey[] = [];
  if (jobNames.length > 0) {
    const nowIso = now.toISOString();
    const results = await env.DB.batch(
      jobNames.map((name) => env.DB.prepare("UPDATE jobs SET next_run_at = ? WHERE name = ?").bind(nowIso, name)),
    );
    const sourceKeyOfJobName = new Map<string, SourceKey>(
      (Object.entries(JOB_NAME_OF) as [SourceKey, string][]).map(([key, name]) => [name, key]),
    );
    queued = jobNames
      .filter((_, index) => (results[index]?.meta.changes ?? 0) > 0)
      .map((name) => sourceKeyOfJobName.get(name))
      .filter((key): key is SourceKey => key !== undefined);
  }

  return c.json({ queued }, 202);
});

export default refreshApi;
