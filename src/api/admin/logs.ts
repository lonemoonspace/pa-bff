// 管理界面「日志」页的后端：GET /admin/api/logs。挂载在 src/api/admin.ts 的 adminApiApp 上，
// 鉴权 / CSRF 校验已由父路由的中间件覆盖。
import { Hono } from "hono";
import { LogsQuerySchema, LogsResponseSchema } from "../../contract/admin";
import type { Env } from "../../env";
import { apiError } from "../../util/errors";
import type { AdminVariables } from "../admin";

const logsApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

interface LogRow {
  id: number;
  at: string;
  level: string;
  source: string;
  message: string;
}

logsApi.get("/logs", async (c) => {
  const parsed = LogsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "查询参数不合法");
  }
  const { limit, before, level, source } = parsed.data;

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (before !== undefined) {
    conditions.push("id < ?");
    binds.push(before);
  }
  if (level !== undefined) {
    conditions.push("level = ?");
    binds.push(level);
  }
  if (source !== undefined) {
    conditions.push("source = ?");
    binds.push(source);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit + 1);

  const { results } = await c.env.DB.prepare(
    `SELECT id, at, level, source, message FROM logs ${where} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...binds)
    .all<LogRow>();

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const entries = page.map((r) => ({ id: r.id, at: r.at, level: r.level, source: r.source, message: r.message }));
  const nextBefore = hasMore ? (entries[entries.length - 1]?.id ?? null) : null;

  return c.json(LogsResponseSchema.parse({ entries, nextBefore }));
});

export default logsApi;
