// 管理界面「设置」页的后端：GET/PUT /admin/api/settings、GET /admin/api/settings/schema、
// GET /admin/api/export、POST /admin/api/import。挂载在 src/api/admin.ts 里的 adminApiApp 上
// （见该文件头注释），鉴权 / CSRF 校验已由父路由的中间件覆盖。
//
// 与 /v1/settings 共用同一套存取函数（config/store.ts 的 getSettingsRecord / putSettings）与
// If-Match 解析（util/if-match.ts）——CONTRACT 第 8 节「管理接口复用 /v1 的业务逻辑」，唯一
// 差别是 updated_by 写 "admin:<email>" 而不是设备 id。
import { Hono } from "hono";
import { z } from "zod";
import { SettingsExportSchema, type SettingsExport } from "../../contract/admin";
import { SettingsSchema } from "../../contract/settings";
import { getSettingsRecord, putSettings, type SettingsRecord } from "../../config/store";
import type { Env } from "../../env";
import { apiError } from "../../util/errors";
import { parseIfMatchRevision } from "../../util/if-match";
import { osloLocalDate } from "../../util/time";
import type { AdminVariables } from "../admin";

const settingsApi = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

function etagOf(revision: number): string {
  return `"r${revision}"`;
}

function toResponseBody(record: SettingsRecord) {
  return { revision: record.revision, settings: record.settings, updatedAt: record.updatedAt };
}

settingsApi.get("/settings", async (c) => {
  const record = await getSettingsRecord(c.env);
  c.header("ETag", etagOf(record.revision));
  return c.json(toResponseBody(record));
});

// zod v4 的 z.toJSONSchema：draft 2020-12，字段与 SettingsSchema 一一对应（14 个）。
// 前端 lib/schema-form.js 用它 + 中文标签表拼表单，新增设置字段时前端不用改代码。
settingsApi.get("/settings/schema", (c) => c.json(z.toJSONSchema(SettingsSchema)));

settingsApi.put("/settings", async (c) => {
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
  const admin = c.get("admin");
  const result = await putSettings(c.env, expectedRevision, parsed.data, admin.actor);

  if (!result.ok) {
    return apiError(c, 409, "revision_conflict", "设置已被其他设备修改", { current: toResponseBody(result.current) });
  }

  c.header("ETag", etagOf(result.record.revision));
  return c.json(toResponseBody(result.record));
});

// 导出**不含任何密钥**（SettingsExportSchema 里根本没有密钥字段）——密钥只写不读，
// 换机器时逐个重新填写，见 contract/admin.ts 文件头注释。
settingsApi.get("/export", async (c) => {
  const record = await getSettingsRecord(c.env);
  const now = new Date();
  const body: SettingsExport = {
    format: "pa-bff-settings",
    version: 1,
    exportedAt: now.toISOString(),
    revision: record.revision,
    settings: record.settings,
  };
  const filename = `pa-bff-settings-${osloLocalDate(now).replace(/-/g, "")}.json`;
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.json(SettingsExportSchema.parse(body));
});

// 导入走与 PUT 相同的 If-Match 乐观锁流程：体本身必须是合法的导出文件外形，
// format / version 不对也按 422 invalid_settings 处理（不单独立一个错误码）。
settingsApi.post("/import", async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch) {
    return apiError(c, 428, "precondition_required", "缺少 If-Match 头");
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = SettingsExportSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 422, "invalid_settings", "导入文件不合法");
  }

  const expectedRevision = parseIfMatchRevision(ifMatch) ?? -1;
  const admin = c.get("admin");
  const result = await putSettings(c.env, expectedRevision, parsed.data.settings, admin.actor);

  if (!result.ok) {
    return apiError(c, 409, "revision_conflict", "设置已被其他设备修改", { current: toResponseBody(result.current) });
  }

  c.header("ETag", etagOf(result.record.revision));
  return c.json(toResponseBody(result.record));
});

export default settingsApi;
