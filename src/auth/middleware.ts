// requireDevice() / requireOwner()：校验设备令牌、挂 device 到 Hono context，
// 并按契约做 last_seen_at 节流与吊销拦截。契约见 CONTRACT.md 第 2 节。
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db/client";
import { devices } from "../db/schema";
import type { Env } from "../env";
import { apiError } from "../util/errors";
import { sha256Hex } from "./tokens";

export type DeviceRow = typeof devices.$inferSelect;

/** 挂在 Hono context 上的自定义变量：requireDevice() 通过后可用 c.get("device") 取当前设备。 */
export type AppVariables = { device: DeviceRow };

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/** 校验 Authorization: Bearer <token>，把命中的设备存进 c.set("device", ...)。 */
export const requireDevice = () =>
  createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!token) {
      return apiError(c, 401, "unauthorized", "缺少设备令牌");
    }

    const tokenHash = await sha256Hex(token);
    const database = db(c.env);
    const rows = await database.select().from(devices).where(eq(devices.tokenHash, tokenHash)).limit(1);
    const device = rows[0];
    if (!device) {
      return apiError(c, 401, "unauthorized", "设备令牌无效");
    }
    if (device.revokedAt) {
      return apiError(c, 401, "revoked", "该设备已被吊销");
    }

    c.set("device", device);

    // 同一设备 5 分钟内最多写一次 last_seen_at，省 D1 写入配额。
    const now = new Date();
    const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (now.getTime() - lastSeenMs >= LAST_SEEN_THROTTLE_MS) {
      await database
        .update(devices)
        .set({ lastSeenAt: now.toISOString() })
        .where(eq(devices.id, device.id));
    }

    await next();
  });

/** 要求当前设备角色为 owner，必须放在 requireDevice() 之后使用。 */
export const requireOwner = () =>
  createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
    const device = c.get("device");
    if (!device || device.role !== "owner") {
      return apiError(c, 403, "forbidden", "需要 owner 权限");
    }
    await next();
  });
