// /v1 路由聚合。本文件只负责把各子路由挂起来；index.ts 只挂 app.ts 这一个整体。
import { Hono } from "hono";
import { claim } from "../auth/claim";
import type { AppVariables } from "../auth/middleware";
import { redeemPairCode } from "../auth/pair";
import type { Env } from "../env";
import { apiError } from "../util/errors";
import dashboardApi from "./dashboard";
import devicesApi from "./devices";
import linesApi from "./lines";
import pushApi from "./push";
import refreshApi from "./refresh";
import secretsApi from "./secrets";
import settingsApi from "./settings";
import stopsApi from "./stops";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post("/claim", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await claim(c.env, body);
  if (result.status === 201) {
    return c.json(result.body, 201);
  }
  return apiError(c, result.status, result.code, result.message);
});

app.post("/pair/redeem", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await redeemPairCode(c.env, body);
  if (result.status === 201) {
    return c.json(result.body, 201);
  }
  return apiError(c, result.status, result.code, result.message);
});

app.route("/devices", devicesApi);
app.route("/settings", settingsApi);
app.route("/secrets", secretsApi);
app.route("/stops", stopsApi);
app.route("/lines", linesApi);
app.route("/dashboard", dashboardApi);
app.route("/refresh", refreshApi);
app.route("/push", pushApi);

export default app;
