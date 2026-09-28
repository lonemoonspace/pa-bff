// 管理界面「设备」页的后端：GET/DELETE/PATCH /admin/api/devices*、POST /admin/api/pair-codes。
// 挂载在 src/api/admin.ts 里的 adminApiApp 上（见该文件头注释），鉴权 / CSRF 校验已由父路由
// 的中间件覆盖，这里不重复处理。业务逻辑全部来自 src/devices/service.ts（与 /v1/devices*
// 共用同一批函数——CONTRACT 第 8 节「管理接口复用 /v1 的业务逻辑」）。
import { Hono } from "hono";
import { z } from "zod";
import { AdminDeviceSchema } from "../../contract/admin";
import { createPairCode, deleteDevice, listDevices, setDeviceRole, toDeviceView } from "../../devices/service";
import type { Env } from "../../env";
import { apiError } from "../../util/errors";
import type { AdminVariables } from "../admin";

const devicesApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

devicesApi.get("/devices", async (c) => {
  const rows = await listDevices(c.env);
  const devices = rows.map((d) => AdminDeviceSchema.parse(toDeviceView(d)));
  return c.json({ devices });
});

devicesApi.post("/pair-codes", async (c) => {
  const admin = c.get("admin");
  const { code, expiresAt } = await createPairCode(c.env, admin.actor);
  return c.json({ code, expiresAt }, 201);
});

devicesApi.delete("/devices/:id", async (c) => {
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

devicesApi.patch("/devices/:id", async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => null);
  const parsed = PatchRoleSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "请求体不合法");
  }

  const result = await setDeviceRole(c.env, id, parsed.data.role);
  if (!result.ok) {
    if (result.code === "not_found") {
      return apiError(c, 404, "not_found", "设备不存在");
    }
    return apiError(c, 409, "last_owner", "不能降级最后一个 owner");
  }

  return c.json(AdminDeviceSchema.parse(toDeviceView(result.device)));
});

export default devicesApi;
