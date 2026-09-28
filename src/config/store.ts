// settings 表存取：GET 用 drizzle 直接读，PUT 用条件更新做乐观锁。
// 乐观锁思路与 auth/claim.ts 的认领竞争一致：把“比较 revision 是否仍是旧值”写进 SQL 的
// WHERE 里，而不是先 SELECT 再在 JS 里判断——这样两个并发 PUT 同时提交时，D1/SQLite 按
// 事务顺序串行执行，只有先提交的那个 UPDATE 影响 1 行，后提交的那个影响 0 行，不存在
// “读到旧值之后、写之前被别人抢先”的竞态窗口。
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "../contract/settings";
import { db } from "../db/client";
import { settings } from "../db/schema";
import type { Env } from "../env";

export type SettingsRecord = {
  revision: number;
  settings: Settings;
  updatedAt: string;
};

/** 读出 settings 表的单行，json 经 SettingsSchema.parse 兼容将来新增字段（缺字段取 default）。 */
export async function getSettingsRecord(env: Env): Promise<SettingsRecord> {
  const row = await db(env).select().from(settings).limit(1);
  const r = row[0];
  if (!r || r.json === null || r.revision === null) {
    // 理论上迁移已经插入了初始行；兜底返回默认设置，不写库（避免掩盖迁移问题）。
    return { revision: 1, settings: DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() };
  }
  return {
    revision: r.revision,
    settings: SettingsSchema.parse(JSON.parse(r.json)),
    updatedAt: r.updatedAt ?? new Date(0).toISOString(),
  };
}

/** 供其他模块（调度器、数据源等）读取当前设置。 */
export async function getSettings(env: Env): Promise<Settings> {
  return (await getSettingsRecord(env)).settings;
}

export type PutSettingsResult =
  | { ok: true; record: SettingsRecord }
  | { ok: false; conflict: true; current: SettingsRecord };

/**
 * 条件更新：WHERE id=1 AND revision=<expectedRevision>。
 * 影响行数为 1 → 本次写入生效，返回新记录；影响行数为 0 → 有并发写入抢先，
 * 重新读一次当前值放进冲突结果里（供调用方拼 409 体的 current 字段）。
 */
export async function putSettings(
  env: Env,
  expectedRevision: number,
  next: Settings,
  updatedBy: string,
  now: Date = new Date(),
): Promise<PutSettingsResult> {
  const newRevision = expectedRevision + 1;
  const updatedAt = now.toISOString();
  const result = await env.DB.prepare(
    "UPDATE settings SET json = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND revision = ?",
  )
    .bind(JSON.stringify(next), newRevision, updatedAt, updatedBy, expectedRevision)
    .run();

  if (result.meta.changes === 1) {
    return { ok: true, record: { revision: newRevision, settings: next, updatedAt } };
  }

  const current = await getSettingsRecord(env);
  return { ok: false, conflict: true, current };
}
