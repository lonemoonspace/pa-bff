// /v1/secrets*：第三方密钥的增删查与测试。契约见 CONTRACT.md 第 3 节 secrets 四行。
// 全部要求 owner；具体的存取/加密逻辑在 src/secrets/store.ts，这里只做 HTTP 层的翻译。
import { Hono } from "hono";
import { z } from "zod";
import { requireDevice, requireOwner, type AppVariables } from "../auth/middleware";
import { SecretNameSchema } from "../contract/settings";
import type { Env } from "../env";
import { deleteSecret, listStatus, putSecret, retest } from "../secrets/store";
import { apiError } from "../util/errors";

const secretsApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

secretsApi.use("*", requireDevice(), requireOwner());

secretsApi.get("/", async (c) => {
  const list = await listStatus(c.env);
  return c.json({ secrets: list });
});

const PutSecretSchema = z.object({ value: z.string() });

secretsApi.put("/:name", async (c) => {
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

secretsApi.delete("/:name", async (c) => {
  const nameParsed = SecretNameSchema.safeParse(c.req.param("name"));
  if (!nameParsed.success) {
    return apiError(c, 404, "not_found", "未知的密钥名字");
  }
  await deleteSecret(c.env, nameParsed.data);
  return c.body(null, 204);
});

secretsApi.post("/:name/test", async (c) => {
  const nameParsed = SecretNameSchema.safeParse(c.req.param("name"));
  if (!nameParsed.success) {
    return apiError(c, 404, "not_found", "未知的密钥名字");
  }
  const status = await retest(c.env, nameParsed.data);
  return c.json(status);
});

export default secretsApi;
