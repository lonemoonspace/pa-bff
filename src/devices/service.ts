// 设备相关的纯业务逻辑：从 api/devices.ts 抽出，供 /v1 与 /admin/api 两套路由共用
// （管理接口复用 /v1 的业务逻辑，见 CONTRACT.md 第 8 节）。HTTP 状态码由各自路由决定，
// 这里只返回判别联合结果。
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createPairCode as createPairCodeImpl } from "../auth/pair";
import { db } from "../db/client";
import { devices } from "../db/schema";
import type { DeviceRow } from "../auth/middleware";
import type { Env } from "../env";

export type { DeviceRow };

/** POST .../pair-codes：owner（或管理员）生成配对码。直接转发 auth/pair.ts 的实现，
 *  这里重新导出只是让 /admin 路由跟 /v1 一样「只调用 devices/service」。 */
export const createPairCode = createPairCodeImpl;

/** 契约里与角色无关的设备视图（不含 tokenHash / pushToken 密文等内部字段、不含 self）。 */
export interface DeviceView {
  id: string;
  name: string;
  role: "owner" | "viewer";
  createdAt: string | null;
  lastSeenAt: string | null;
  hasPushToken: boolean;
}

export function toDeviceView(d: DeviceRow): DeviceView {
  return {
    id: d.id,
    name: d.name ?? "",
    role: d.role === "owner" ? "owner" : "viewer",
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    hasPushToken: Boolean(d.pushTokenCt),
  };
}

/** GET .../devices：所有未吊销的设备。 */
export async function listDevices(env: Env): Promise<DeviceRow[]> {
  const database = db(env);
  return database.select().from(devices).where(isNull(devices.revokedAt));
}

// G2 修复 4：不能先在 JS 里 SELECT 数一遍 owner 数量再决定要不要 UPDATE——两个并发请求
// 会各自读到「还有别的 owner」从而都通过检查，结果把最后两个 owner 一起降级/删除。必须把
// 「除自己以外还有至少一个有效 owner」写进 UPDATE 语句本身的 WHERE 条件里。
function otherValidOwnerExists(excludingId: string) {
  return sql`(SELECT COUNT(*) FROM devices WHERE role = 'owner' AND revoked_at IS NULL AND id != ${excludingId}) >= 1`;
}

export type DeleteDeviceResult = { ok: true } | { ok: false; code: "not_found" | "last_owner" };

/** DELETE .../devices/:id：吊销设备并作废其生成的未用配对码（同一个 db.batch）。 */
export async function deleteDevice(env: Env, id: string, now: Date = new Date()): Promise<DeleteDeviceResult> {
  const database = db(env);
  const existing = await database.select().from(devices).where(eq(devices.id, id)).limit(1);
  const target = existing[0];
  if (!target || target.revokedAt) {
    return { ok: false, code: "not_found" };
  }

  const nowIso = now.toISOString();
  const invalidationMarker = `revoked:${nowIso}#${crypto.randomUUID()}`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE devices SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL
         AND (role != 'owner' OR (SELECT COUNT(*) FROM devices WHERE role = 'owner' AND revoked_at IS NULL AND id != ?) >= 1)`,
    ).bind(nowIso, id, id),
    env.DB.prepare(
      `UPDATE pair_codes SET used_at = ?
       WHERE created_by = ? AND used_at IS NULL
         AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked_at = ?)`,
    ).bind(invalidationMarker, id, id, nowIso),
  ]);

  const revokeResult = results[0];
  if (!revokeResult || revokeResult.meta.changes !== 1) {
    return { ok: false, code: "last_owner" };
  }
  return { ok: true };
}

export type SetRoleResult = { ok: true; device: DeviceRow } | { ok: false; code: "not_found" | "last_owner" };

/** PATCH .../devices/:id：改角色，降级到 viewer 时保护最后一个 owner。 */
export async function setDeviceRole(env: Env, id: string, role: "owner" | "viewer"): Promise<SetRoleResult> {
  const database = db(env);
  const existing = await database.select().from(devices).where(eq(devices.id, id)).limit(1);
  if (!existing[0]) {
    return { ok: false, code: "not_found" };
  }

  // G3 修复 9：guard 是否加上，只看「新角色是不是 viewer」，不依赖前面 SELECT 读到的角色
  // ——那个读出来的角色可能已经过期。只要新角色是 viewer，就无条件把「目标不是 owner 或者
  // 还有别的有效 owner」写进 WHERE，让数据库在真正执行 UPDATE 的那一刻按当时的行状态判断。
  const demotingToViewer = role === "viewer";
  const updated = await database
    .update(devices)
    .set({ role })
    .where(and(eq(devices.id, id), demotingToViewer ? or(sql`role != 'owner'`, otherValidOwnerExists(id)) : sql`1 = 1`))
    .returning();

  if (updated.length === 0) {
    return { ok: false, code: "last_owner" };
  }
  return { ok: true, device: updated[0]! };
}
