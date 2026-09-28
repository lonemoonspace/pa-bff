// GET /v1/lines：关注线路选择用，列出两个站共同经过的线路。契约见 CONTRACT.md 第 3、9 节。
// 任意已认证设备可用，不要求 owner（与 stops/search 一致）。
import { Hono } from "hono";
import { requireDevice, type AppVariables } from "../auth/middleware";
import { LinesQuerySchema } from "../contract/lines";
import type { Env } from "../env";
import { fetchCommonLines } from "../sources/entur-lines";
import { apiError } from "../util/errors";

const linesApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

linesApi.use("*", requireDevice());

linesApi.get("/", async (c) => {
  const parsed = LinesQuerySchema.safeParse({
    stopA: c.req.query("stopA") ?? "",
    stopB: c.req.query("stopB") ?? "",
  });
  if (!parsed.success) {
    return apiError(c, 422, "invalid_request", "stopA / stopB 必须是 NSR:StopPlace:<数字>");
  }

  try {
    const lines = await fetchCommonLines(parsed.data.stopA, parsed.data.stopB);
    return c.json({ lines });
  } catch {
    return apiError(c, 502, "upstream_error", "Entur 线路查询失败");
  }
});

export default linesApi;
