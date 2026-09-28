// fetch + scheduled 入口。
import { Hono } from "hono";
import adminApp from "./api/admin";
import apiApp from "./api/app";
import type { AppVariables } from "./auth/middleware";
import type { Env } from "./env";
// 注册所有任务处理器（housekeeping 起，P3 起陆续加入 weather 等）；tick() 需要它们才有活干。
import "./jobs/index";
import { tick } from "./scheduler/tick";
import { apiError } from "./util/errors";

export const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get("/healthz", async (c) => {
  // 读 meta.last_tick_at；数据库还没跑过迁移（例如某些不建库的单测）或还没 tick 过时，
  // 一律当成 null，不让 /healthz 因为这个附加信息而挂掉。
  let lastTickAt: string | null = null;
  try {
    const row = await c.env.DB.prepare("SELECT value FROM meta WHERE key = 'last_tick_at'").first<{
      value: string | null;
    }>();
    lastTickAt = row?.value ?? null;
  } catch {
    lastTickAt = null;
  }
  return c.json({ ok: true, lastTickAt });
});

app.route("/v1", apiApp);
app.route("/admin", adminApp);

app.notFound((c) => apiError(c, 404, "not_found", "未找到该接口"));

// 全局错误处理（G2 修复 6）：任何未捕获的异常都必须落成契约格式的 500 internal_error，
// 消息用固定的通用文案，绝不把异常内容（可能带着机密、内部路径等）回显给客户端。
// 服务器侧仍然打印一份完整堆栈方便排查。
app.onError((err, c) => {
  console.error("unhandled error", err);
  return apiError(c, 500, "internal_error", "服务器内部错误");
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 用 waitUntil 包住 tick：cron 触发器不等 fetch 返回，必须显式延长执行生命周期，
    // 否则 Worker 可能在 tick 内部的 DB 操作 / healthcheck ping 完成前就被回收。
    ctx.waitUntil(tick(env, ctx));
  },
};
