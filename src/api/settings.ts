// GET/PUT /v1/settings。契约见 CONTRACT.md 第 3 节 settings 两行。
// PUT 的乐观锁细节见 src/config/store.ts；本文件只负责 HTTP 层：解析 If-Match、
// 校验 body、把 store 的结果翻译成契约规定的状态码与响应体。
import { Hono } from "hono";
import { requireDevice, requireOwner, type AppVariables } from "../auth/middleware";
import { SettingsSchema } from "../contract/settings";
import { getSettingsRecord, putSettings, type SettingsRecord } from "../config/store";
import type { Env } from "../env";
import { apiError } from "../util/errors";
import { parseIfMatchRevision } from "../util/if-match";

const settingsApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();

settingsApi.use("*", requireDevice());

function etagOf(revision: number): string {
  return `"r${revision}"`;
}

function toResponseBody(record: SettingsRecord) {
  return { revision: record.revision, settings: record.settings, updatedAt: record.updatedAt };
}

settingsApi.get("/", async (c) => {
  const record = await getSettingsRecord(c.env);
  c.header("ETag", etagOf(record.revision));
  return c.json(toResponseBody(record));
});

settingsApi.put("/", requireOwner(), async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch) {
    return apiError(c, 428, "precondition_required", "缺少 If-Match 头");
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = SettingsSchema.safeParse((raw as { settings?: unknown } | null)?.settings);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return apiError(c, 422, "invalid_settings", "设置不合法", { issues });
  }

  const expectedRevision = parseIfMatchRevision(ifMatch) ?? -1;
  const device = c.get("device");
  const result = await putSettings(c.env, expectedRevision, parsed.data, device.id);

  if (!result.ok) {
    return apiError(c, 409, "revision_conflict", "设置已被其他设备修改", { current: toResponseBody(result.current) });
  }

  c.header("ETag", etagOf(result.record.revision));
  return c.json(toResponseBody(result.record));
});

export default settingsApi;
