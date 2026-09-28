// /v1/devices*：设备列表 / 吊销 / 改角色 / 配对码 / push token。契约见 CONTRACT.md 第 3 节。
// 挂在这个子路由上的所有接口都要求先有合法设备令牌（requireDevice），
// 具体到某个接口再叠加 requireOwner()。
//
// 业务逻辑（列表、吊销、改角色、生成配对码）都在 src/devices/service.ts 里，供 /admin/api
// 的管理接口（T7.3）复用；这里只负责把 HTTP 请求翻成对 service 的调用，把 service 的判别
// 联合结果翻成契约里的状态码。
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireDevice, requireOwner, type AppVariables } from "../auth/middleware";
import { importMasterKey, seal } from "../crypto/secretbox";
import { db } from "../db/client";
import { devices } from "../db/schema";
import { createPairCode, deleteDevice, listDevices, setDeviceRole, toDeviceView } from "../devices/service";
import type { Env } from "../env";
import { apiError } from "../util/errors";

const devicesApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

devicesApi.use("*", requireDevice());

devicesApi.get("/", requireOwner(), async (c) => {
  const self = c.get("device");
  const rows = await listDevices(c.env);
  return c.json({ devices: rows.map((d) => ({ ...toDeviceView(d), self: d.id === self.id })) });
});

devicesApi.post("/pair-codes", requireOwner(), async (c) => {
  const self = c.get("device");
  const { code, expiresAt } = await createPairCode(c.env, self.id);
  return c.json({ code, expiresAt }, 201);
});

const PushTokenSchema = z.object({ token: z.string().min(1) });

devicesApi.put("/me/push-token", async (c) => {
  const self = c.get("device");
  const raw = await c.req.json().catch(() => null);
  const parsed = PushTokenSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_value", "push token 不合法");
  }
  const key = await importMasterKey(c.env.MASTER_KEY);
  const sealed = await seal(key, parsed.data.token, "push_token");
  const database = db(c.env);
  await database
    .update(devices)
    .set({ pushTokenCt: sealed.ciphertext, pushTokenIv: sealed.iv })
    .where(eq(devices.id, self.id));
  return c.body(null, 204);
});

devicesApi.delete("/:id", requireOwner(), async (c) => {
  const id = c.req.param("id");
  const result = await deleteDevice(c.env, id);
  if (!result.ok) {
    if (result.code === "not_found") {
      return apiError(c, 404, "not_found", "设备不存在");
    }
    return apiError(c, 409, "last_owner", "不能删除最后一个有效 owner");
  }
  return c.body(null, 204);
});

const PatchRoleSchema = z.object({ role: z.enum(["owner", "viewer"]) });

devicesApi.patch("/:id", requireOwner(), async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => null);
  const parsed = PatchRoleSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_role", "非法的角色");
  }

  const result = await setDeviceRole(c.env, id, parsed.data.role);
  if (!result.ok) {
    if (result.code === "not_found") {
      return apiError(c, 404, "not_found", "设备不存在");
    }
    return apiError(c, 409, "last_owner", "不能降级最后一个 owner");
  }

  const self = c.get("device");
  return c.json({ ...toDeviceView(result.device), self: result.device.id === self.id });
});

export default devicesApi;
