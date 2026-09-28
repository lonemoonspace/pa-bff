// 快照存储：各数据源最近一次成功/失败结果的读写。
// data 序列化进 snapshots.json；error 按契约 SourceErrorSchema 的形状序列化进 error_json，
// 读出时原样反序列化，直接对应 dashboard 信封（state / fetchedAt / observedAt / error / data）需要的字段。
//
// 时间一律通过参数 now: Date 注入（不读 Date.now()），便于测试固定时钟。
import { eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db/client";
import { snapshots } from "../db/schema";
import type { SourceErrorSchema, SourceStateSchema } from "../contract/dashboard";
import type { Env } from "../env";

export type SourceState = z.infer<typeof SourceStateSchema>;
export type SourceError = z.infer<typeof SourceErrorSchema>;

/** get() 的返回形状，直接对应 dashboard 信封（除 source 外）需要的字段。 */
export interface SnapshotEnvelope {
  state: SourceState;
  fetchedAt: string | null;
  observedAt: string | null;
  error: SourceError | null;
  data: unknown | null;
}

export interface PutSuccessOptions {
  /** 数据本身描述的时刻；无法区分时调用方应传 fetchedAt 同值。 */
  observedAt: string | null;
  etag?: string | null;
  lastModified?: string | null;
  /** 生成该快照时所用设置的指纹，见 CONTRACT.md 第 4 节。 */
  configKey?: string | null;
}

/** 成功拿到新数据：整份覆盖 json / state=ok / 清空 error，写入本次的 etag / lastModified / configKey。 */
export async function putSuccess(
  env: Env,
  source: string,
  data: unknown,
  options: PutSuccessOptions,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const json = JSON.stringify(data);
  const values = {
    source,
    json,
    state: "ok" as const,
    fetchedAt: nowIso,
    observedAt: options.observedAt,
    errorJson: null,
    etag: options.etag ?? null,
    lastModified: options.lastModified ?? null,
    configKey: options.configKey ?? null,
  };
  await db(env)
    .insert(snapshots)
    .values(values)
    .onConflictDoUpdate({ target: snapshots.source, set: values });
}

/**
 * 上游返回 304：数据没变，只挪动 fetched_at 并把 state 置回 ok，不动 json / observedAt /
 * etag 等。F4：连带清空 error_json——上一轮若是失败后收到 304，代表这一轮没有变化，
 * 不该继续挂着上一轮失败时的错误信息（信封的 state=ok 时 error 必须为 null，见
 * CONTRACT.md 第 3 节「来源信封的不变式」）。
 */
export async function putNotModified(env: Env, source: string, now: Date): Promise<void> {
  await db(env)
    .update(snapshots)
    .set({ fetchedAt: now.toISOString(), state: "ok" as const, errorJson: null })
    .where(eq(snapshots.source, source));
}

/** 从未写过 configKey 的行——只有 configKey 相同才能安全复用旧数据。 */
async function currentConfigKey(env: Env, source: string): Promise<{ exists: boolean; configKey: string | null }> {
  const rows = await db(env)
    .select({ configKey: snapshots.configKey })
    .from(snapshots)
    .where(eq(snapshots.source, source))
    .limit(1);
  const row = rows[0];
  if (!row) return { exists: false, configKey: null };
  return { exists: true, configKey: row.configKey };
}

/**
 * 本次刷新失败：configKey 与已有行相同时保留旧 json（不改 fetched_at / observed_at），
 * 只把 state 置为 stale 并写入 error；configKey 不同（或没有旧行）时整行重写——旧数据
 * 属于另一份设置，不能继续挂在新 configKey 名下冒充「陈旧但有效」的数据（F4）。
 */
export async function putFailure(
  env: Env,
  source: string,
  error: SourceError,
  configKey: string | null,
  now: Date,
): Promise<void> {
  const errorJson = JSON.stringify(error);
  const prior = await currentConfigKey(env, source);

  if (prior.exists && prior.configKey === configKey) {
    await db(env)
      .update(snapshots)
      .set({ state: "stale" as const, errorJson })
      .where(eq(snapshots.source, source));
    return;
  }

  const values = {
    source,
    json: null,
    state: "stale" as const,
    fetchedAt: null,
    observedAt: null,
    errorJson,
    etag: null,
    lastModified: null,
    configKey,
  };
  await db(env).insert(snapshots).values(values).onConflictDoUpdate({ target: snapshots.source, set: values });
  void now; // 失败时不更新 fetched_at，保留形参是为了与其它 put* 函数签名一致，便于调用方统一传时钟
}

/**
 * 设为 not_configured（缺设置/密钥）或 idle（按日程本就不刷新）。
 *
 * - configKey 与已有行相同且 state 是 idle：只改 state，保留已有数据（按日程暂停刷新，
 *   数据仍然有效）。
 * - state 是 not_configured：一律清空 json / etag / last_modified（F4）——「未配置」
 *   意味着旧数据不该再被当作有效数据展示，哪怕 configKey 没变。
 * - configKey 与已有行不同（或没有旧行）：整行重写，旧数据不可见（同 putFailure）。
 */
export async function putState(
  env: Env,
  source: string,
  state: "not_configured" | "idle",
  configKey: string | null,
  now: Date,
): Promise<void> {
  const prior = await currentConfigKey(env, source);

  if (prior.exists && prior.configKey === configKey && state !== "not_configured") {
    await db(env).update(snapshots).set({ state }).where(eq(snapshots.source, source));
    return;
  }

  const values = {
    source,
    json: null,
    state,
    fetchedAt: null,
    observedAt: null,
    errorJson: null,
    etag: null,
    lastModified: null,
    configKey,
  };
  await db(env).insert(snapshots).values(values).onConflictDoUpdate({ target: snapshots.source, set: values });
  void now;
}

/**
 * 读取某数据源的快照。configKey 不匹配（例如设置里的车站换了）视为不存在，
 * 避免把另一条路线的缓存显示出来；不存在时返回 null。
 */
export async function get(env: Env, source: string, configKey: string | null): Promise<SnapshotEnvelope | null> {
  const rows = await db(env).select().from(snapshots).where(eq(snapshots.source, source)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.configKey !== configKey) return null;
  return {
    state: (row.state ?? "stale") as SourceState,
    fetchedAt: row.fetchedAt,
    observedAt: row.observedAt,
    error: row.errorJson ? (JSON.parse(row.errorJson) as SourceError) : null,
    data: row.json ? JSON.parse(row.json) : null,
  };
}

/**
 * 批量读取（T5.3：notify 任务一次性拿齐多个来源的快照）：一条 SELECT ... WHERE source
 * IN (...) 覆盖所有请求的来源，逐个按 configKey 是否匹配决定返回该来源的信封还是
 * null——判断规则与 get() 完全一致，只是省掉了逐来源各发一次查询。
 */
export async function getMany(
  env: Env,
  reqs: { source: string; configKey: string | null }[],
): Promise<Record<string, SnapshotEnvelope | null>> {
  const result: Record<string, SnapshotEnvelope | null> = {};
  if (reqs.length === 0) return result;

  const sources = reqs.map((r) => r.source);
  const rows = await db(env).select().from(snapshots).where(inArray(snapshots.source, sources));
  const rowBySource = new Map(rows.map((row) => [row.source, row]));

  for (const req of reqs) {
    const row = rowBySource.get(req.source);
    if (!row || row.configKey !== req.configKey) {
      result[req.source] = null;
      continue;
    }
    result[req.source] = {
      state: (row.state ?? "stale") as SourceState,
      fetchedAt: row.fetchedAt,
      observedAt: row.observedAt,
      error: row.errorJson ? (JSON.parse(row.errorJson) as SourceError) : null,
      data: row.json ? JSON.parse(row.json) : null,
    };
  }
  return result;
}

export interface SnapshotValidators {
  etag: string | null;
  lastModified: string | null;
}

/**
 * 读取某数据源上次成功结果的条件请求校验值（etag / lastModified），供 weather.ts 之类
 * 需要带 If-Modified-Since / If-None-Match 请求上游的任务使用（F6：改用这个而不是直接
 * 查 snapshots 表，两处对「什么时候算没有可比对的旧值」的判断不会再各写一份）。
 *
 * 没有行、configKey 不匹配（设置变了）或 json 为 null（从没成功过，只是失败/未配置的
 * 占位行）都返回 null——这些情况下都不该带条件请求，否则会把不相关的旧校验值套用到
 * 新一轮请求上。
 */
export async function getValidators(env: Env, source: string, configKey: string | null): Promise<SnapshotValidators | null> {
  const rows = await db(env)
    .select({ configKey: snapshots.configKey, json: snapshots.json, etag: snapshots.etag, lastModified: snapshots.lastModified })
    .from(snapshots)
    .where(eq(snapshots.source, source))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.configKey !== configKey) return null;
  if (row.json === null) return null;
  return { etag: row.etag, lastModified: row.lastModified };
}
