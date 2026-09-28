// 管理界面「总览」页的后端：GET /admin/api/overview 与 POST /admin/api/jobs/:name/run。
// 挂载在 src/api/admin.ts 里的 adminApiApp 上（见该文件头注释），鉴权 / CSRF 校验已由
// 父路由的中间件覆盖，这里不重复处理。
//
// D1 预算（CONTRACT 第 5 节「预算」精神同样适用于管理接口，卡片要求 ≤ 6 次）：
// meta（1，IN 查询一次取两个 key）、settings（1）、devices 聚合（1）、jobs 全表（1）、
// snapshots 全表（1）、secrets（1，见 secrets/store.ts 的 listStatus——它内部也只发
// 一条 SELECT * FROM secrets，不是逐个密钥名各查一次）。密钥状态的判定逻辑（missing /
// present / unreadable、hint、lastTest 解析）只在 secrets/store.ts 里有一份，这里直接
// 复用 listStatus，不再自己解密拼状态（安全相关代码不能有两份实现，调度员复核 T7.2）。
import { Hono } from "hono";
import type { AdminVariables } from "../admin";
import { OverviewSchema, RunnableJobSchema, type Overview } from "../../contract/admin";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "../../contract/settings";
import { db } from "../../db/client";
import { jobs as jobsTable, settings as settingsTable, snapshots as snapshotsTable } from "../../db/schema";
import type { Env } from "../../env";
import { listStatus } from "../../secrets/store";
import { configKeysFor, type ConfigKeys } from "../../snapshot/config-keys";
import { apiError } from "../../util/errors";

const overviewApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

/** 与 dashboard.ts 的顺序一致，只是用快照表里实际的 source 列值（snake_case）。 */
const SOURCE_ORDER = ["weather", "train", "traffic_outbound", "traffic_return", "bus", "football"] as const;

interface SettingsSummary {
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  settings: Settings;
}

/** 读单行 settings 表；没有行（未迁移）时退回默认设置，revision=1，时间/操作者为 null。 */
async function readSettingsSummary(env: Env): Promise<SettingsSummary> {
  const rows = await db(env).select().from(settingsTable).limit(1);
  const row = rows[0];
  if (!row || row.json === null || row.revision === null) {
    return { revision: 1, updatedAt: null, updatedBy: null, settings: DEFAULT_SETTINGS };
  }
  return {
    revision: row.revision,
    updatedAt: row.updatedAt ?? null,
    updatedBy: row.updatedBy ?? null,
    settings: SettingsSchema.parse(JSON.parse(row.json)),
  };
}

interface MetaSummary {
  lastTickAt: string | null;
  claimedAt: string | null;
}

async function readMeta(env: Env): Promise<MetaSummary> {
  const result = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('last_tick_at', 'claimed_at')")
    .all<{ key: string; value: string | null }>();
  const byKey = new Map(result.results.map((r) => [r.key, r.value]));
  return {
    lastTickAt: byKey.get("last_tick_at") ?? null,
    claimedAt: byKey.get("claimed_at") ?? null,
  };
}

interface DeviceSummary {
  total: number;
  owners: number;
  withPushToken: number;
}

async function readDeviceSummary(env: Env): Promise<DeviceSummary> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owners,
            SUM(CASE WHEN push_token_ct IS NOT NULL THEN 1 ELSE 0 END) AS withPushToken
     FROM devices WHERE revoked_at IS NULL`,
  ).first<{ total: number | null; owners: number | null; withPushToken: number | null }>();
  return {
    total: row?.total ?? 0,
    owners: row?.owners ?? 0,
    withPushToken: row?.withPushToken ?? 0,
  };
}

function configKeyFor(keys: ConfigKeys, source: (typeof SOURCE_ORDER)[number]): string | null {
  return keys[source];
}

async function readSourceRows(env: Env, keys: ConfigKeys): Promise<Overview["sources"]> {
  const rows = await db(env).select().from(snapshotsTable);
  const bySource = new Map(rows.map((r) => [r.source, r]));

  return SOURCE_ORDER.map((source) => {
    const row = bySource.get(source);
    const configKey = configKeyFor(keys, source);
    if (!row) {
      return { source, state: null, fetchedAt: null, observedAt: null, error: null, configMatches: false };
    }
    return {
      source,
      state: (row.state ?? "stale") as Overview["sources"][number]["state"],
      fetchedAt: row.fetchedAt,
      observedAt: row.observedAt,
      error: row.errorJson ? JSON.parse(row.errorJson) : null,
      configMatches: row.configKey === configKey,
    };
  });
}

async function readJobRows(env: Env): Promise<Overview["jobs"]> {
  const rows = await db(env).select().from(jobsTable);
  return rows.map((r) => ({
    name: r.name,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    lastDurationMs: r.lastDurationMs,
    failCount: r.failCount ?? 0,
    leaseUntil: r.leaseUntil,
  }));
}

overviewApi.get("/overview", async (c) => {
  const env = c.env;
  const now = new Date();

  const [meta, settingsSummary, devices, jobsRows] = await Promise.all([
    readMeta(env),
    readSettingsSummary(env),
    readDeviceSummary(env),
    readJobRows(env),
  ]);
  const keys = configKeysFor(settingsSummary.settings);
  const [sources, secretStatuses] = await Promise.all([readSourceRows(env, keys), listStatus(env)]);

  const overview: Overview = OverviewSchema.parse({
    now: now.toISOString(),
    lastTickAt: meta.lastTickAt,
    claimedAt: meta.claimedAt,
    settings: {
      revision: settingsSummary.revision,
      updatedAt: settingsSummary.updatedAt,
      updatedBy: settingsSummary.updatedBy,
    },
    devices,
    jobs: jobsRows,
    sources,
    secrets: secretStatuses,
  });

  return c.json(overview);
});

overviewApi.post("/jobs/:name/run", async (c) => {
  const parsed = RunnableJobSchema.safeParse(c.req.param("name"));
  if (!parsed.success) {
    return apiError(c, 404, "not_found", "未知或不开放的任务名");
  }
  const name = parsed.data;
  const nowIso = new Date().toISOString();

  const row = await c.env.DB.prepare(
    `INSERT INTO jobs (name, next_run_at) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET next_run_at = excluded.next_run_at
     RETURNING name`,
  )
    .bind(name, nowIso)
    .first<{ name: string }>();

  return c.json({ queued: row?.name ?? name }, 202);
});

export default overviewApi;
