// POST /v1/push/test：owner 手动触发一次测试推送，走 6.4 的同一条投递路径（policy = "test"，
// 文案固定）。契约见 CONTRACT.md 第 3 节 push/test 一行与第 6.5 节。
//
// 业务逻辑（节流 + 投递）在 src/notify/test-push.ts 里，供 /admin/api/push/test（T7.3）
// 复用；这里只负责把 HTTP 请求翻成调用、把判别联合结果翻成状态码。
import { Hono } from "hono";
import { requireDevice, requireOwner, type AppVariables } from "../auth/middleware";
import { PushTestRequestSchema } from "../contract/push";
import type { Env } from "../env";
import { runTestPush } from "../notify/test-push";
import { apiError } from "../util/errors";

const pushApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

pushApi.use("*", requireDevice());

pushApi.post("/test", requireOwner(), async (c) => {
  const env = c.env;
  const now = new Date();

  const raw = await c.req.json().catch(() => ({}));
  const parsed = PushTestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "请求体不合法");
  }
  const { scope } = parsed.data;

  const device = c.get("device");
  const deviceIds = scope === "self" ? [device.id] : undefined;

  const result = await runTestPush(env, now, deviceIds);
  if (!result.ok) {
    if (result.code === "too_soon") {
      return apiError(c, 429, "too_soon", "测试推送过于频繁，请 30 秒后再试");
    }
    if (result.code === "no_push_token") {
      return apiError(c, 409, "no_push_token", "没有可发送的设备");
    }
    return apiError(c, 503, "fcm_not_configured", "FCM 服务账号缺失、无法解密或字段不全");
  }

  return c.json({ deviceCount: result.deviceCount, result: result.result }, 200);
});

export default pushApi;
