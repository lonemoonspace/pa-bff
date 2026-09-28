// 管理界面「推送」页的后端：GET /admin/api/push-log、POST /admin/api/push/test。挂载在
// src/api/admin.ts 的 adminApiApp 上，鉴权 / CSRF 校验已由父路由的中间件覆盖。测试推送
// 复用 src/notify/test-push.ts（与 /v1/push/test 共用同一条节流 + 投递路径与 meta.push_test_at）。
import { Hono } from "hono";
import { AdminPushTestRequestSchema, PageQuerySchema, PushLogResponseSchema } from "../../contract/admin";
import { PushLogResultSchema } from "../../contract/push";
import type { Env } from "../../env";
import { runTestPush } from "../../notify/test-push";
import { apiError } from "../../util/errors";
import type { AdminVariables } from "../admin";

const pushApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

interface PushLogRow {
  id: number;
  at: string;
  policy: string;
  title: string;
  body: string;
  device_count: number;
  result: string | null;
}

pushApi.get("/push-log", async (c) => {
  const parsed = PageQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "查询参数不合法");
  }
  const { limit, before } = parsed.data;

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (before !== undefined) {
    conditions.push("id < ?");
    binds.push(before);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit + 1);

  const { results } = await c.env.DB.prepare(
    `SELECT id, at, policy, title, body, device_count, result FROM push_log ${where} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...binds)
    .all<PushLogRow>();

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const entries = page.map((r) => {
    let parsedResult = null;
    if (r.result !== null) {
      try {
        const rp = PushLogResultSchema.safeParse(JSON.parse(r.result));
        parsedResult = rp.success ? rp.data : null;
      } catch {
        parsedResult = null;
      }
    }
    return {
      id: r.id,
      at: r.at,
      policy: r.policy,
      title: r.title,
      body: r.body,
      deviceCount: r.device_count,
      result: parsedResult,
    };
  });
  const nextBefore = hasMore ? (entries[entries.length - 1]?.id ?? null) : null;

  return c.json(PushLogResponseSchema.parse({ entries, nextBefore }));
});

pushApi.post("/push/test", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = AdminPushTestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "请求体不合法");
  }
  const { deviceId } = parsed.data;

  if (deviceId !== undefined) {
    const row = await c.env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first();
    if (!row) {
      return apiError(c, 404, "not_found", "设备不存在");
    }
  }

  const now = new Date();
  const result = await runTestPush(c.env, now, deviceId !== undefined ? [deviceId] : undefined);
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
