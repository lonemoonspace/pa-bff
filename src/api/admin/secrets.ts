// 管理界面「密钥」区的后端：GET/PUT/DELETE/POST test，四个接口直接复用
// src/secrets/store.ts（与 /v1/secrets* 共用同一批函数——CONTRACT 第 8 节
// 「管理接口复用 /v1 的业务逻辑」）。挂载在 src/api/admin.ts 里的 adminApiApp 上，
// 鉴权 / CSRF 校验已由父路由的中间件覆盖。
import { Hono } from "hono";
import { z } from "zod";
import { SecretNameSchema } from "../../contract/settings";
import type { Env } from "../../env";
import { deleteSecret, listStatus, putSecret, retest } from "../../secrets/store";
import { apiError } from "../../util/errors";
import type { AdminVariables } from "../admin";

const secretsApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

secretsApi.get("/secrets", async (c) => {
  const list = await listStatus(c.env);
  return c.json({ secrets: list });
});

const PutSecretSchema = z.object({ value: z.string() });

secretsApi.put("/secrets/:name", async (c) => {
  const nameParsed = SecretNameSchema.safeParse(c.req.param("name"));
  if (!nameParsed.success) {
    return apiError(c, 404, "not_found", "未知的密钥名字");
  }

  const raw = await c.req.json().catch(() => null);
  const bodyParsed = PutSecretSchema.safeParse(raw);
  if (!bodyParsed.success) {
    return apiError(c, 422, "invalid_value", "密钥值不合法");
  }

  const result = await putSecret(c.env, nameParsed.data, bodyParsed.data.value);
  if (!result.ok) {
    return apiError(c, 422, "invalid_value", "密钥值不合法");
  }
  return c.json(result.status);
});

secretsApi.delete("/secrets/:name", async (c) => {
  const nameParsed = SecretNameSchema.safeParse(c.req.param("name"));
  if (!nameParsed.success) {
    return apiError(c, 404, "not_found", "未知的密钥名字");
  }
  await deleteSecret(c.env, nameParsed.data);
  return c.body(null, 204);
});

secretsApi.post("/secrets/:name/test", async (c) => {
  const nameParsed = SecretNameSchema.safeParse(c.req.param("name"));
  if (!nameParsed.success) {
    return apiError(c, 404, "not_found", "未知的密钥名字");
  }
  const status = await retest(c.env, nameParsed.data);
  return c.json(status);
});

export default secretsApi;
