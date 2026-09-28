// GET /v1/stops/search：站点搜索（设置页选站点用）。契约见 CONTRACT.md 第 3 节
// stops/search 一行。任意已认证设备可用，不要求 owner。
import { Hono } from "hono";
import { requireDevice, type AppVariables } from "../auth/middleware";
import type { Env } from "../env";
import { searchStops } from "../sources/entur-stops";
import { apiError } from "../util/errors";

const stopsApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

stopsApi.use("*", requireDevice());

stopsApi.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.length < 2 || q.length > 60) {
    return apiError(c, 422, "invalid_query", "q 长度必须在 2..60 之间");
  }
  const stops = await searchStops(q);
  return c.json({ stops });
});

export default stopsApi;
