// GET/PUT /admin/api/settings、GET /admin/api/settings/schema、GET /admin/api/export、
// POST /admin/api/import 的集成测试。用本地开发旁路（ADMIN_DEV_BYPASS=1 + localhost）
// 跳过 Access JWT 签发的麻烦——T7.1 已经把该旁路本身测过了。
// **既有 /v1/settings 测试不改一行**，这里只关心管理接口自己的路由与状态码映射。
import { applyD1Migrations, env } from "cloudflare:test";
import { z } from "zod";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { SettingsSchema } from "../../src/contract/settings";
import type { Env } from "../../src/env";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const INITIAL_SETTINGS_JSON =
  '{"originAddress":"","destinationAddress":"","originStation":"Spikkestad","destStation":"Nationaltheatret","workWindowStart":"07:00","workWindowEnd":"10:00","returnWindowStart":"14:00","returnWindowEnd":"16:00","notifyCommuteDisruption":false,"notifyFootballMatch":false,"notifyMorningBrief":false,"transitPassUntil":"","parkingPassUntil":"","notifyTicketExpiry":false}';

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM secrets");
  await env.DB.exec(
    `UPDATE settings SET json = '${INITIAL_SETTINGS_JSON}', revision = 1, updated_at = '2026-01-01T00:00:00.000Z', updated_by = NULL WHERE id = 1`,
  );
});

function adminEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
    ACCESS_AUD: "test-aud-tag",
    ADMIN_DEV_BYPASS: "1",
    ...overrides,
  } as unknown as Env;
}

function get(path: string, testEnv: Env = adminEnv()) {
  return app.request(`http://localhost${path}`, {}, testEnv);
}

function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "X-PA-Admin": "1", Origin: "http://localhost" },
  testEnv: Env = adminEnv(),
) {
  const init: RequestInit = { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(`http://localhost${path}`, init, testEnv);
}

async function getSettings() {
  const res = await get("/admin/api/settings");
  expect(res.status).toBe(200);
  return res.json<{ revision: number; settings: Record<string, unknown>; updatedAt: string }>();
}

describe("GET /admin/api/settings/schema", () => {
  it("与 z.toJSONSchema(SettingsSchema) 深相等，属性数为 20（[gate] P9 新增六个 watchedLine* 字段）", async () => {
    const res = await get("/admin/api/settings/schema");
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = z.toJSONSchema(SettingsSchema);
    expect(Object.keys((expected as { properties: Record<string, unknown> }).properties)).toHaveLength(20);
    expect(body).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});

describe("PUT /admin/api/settings", () => {
  it("成功时 updated_by 为 admin:<email>", async () => {
    const body = await getSettings();
    const res = await send("PUT", "/admin/api/settings", { settings: { ...body.settings, originStation: "Asker" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${body.revision}"`,
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT updated_by FROM settings WHERE id = 1").first<{ updated_by: string }>();
    expect(row?.updated_by).toBe("admin:dev@localhost");
  });

  it("缺 If-Match → 428", async () => {
    const body = await getSettings();
    const res = await send("PUT", "/admin/api/settings", { settings: body.settings });
    expect(res.status).toBe(428);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("precondition_required");
  });

  it("过期 revision → 409 revision_conflict，体里带 current", async () => {
    const body = await getSettings();
    const first = await send("PUT", "/admin/api/settings", { settings: { ...body.settings, originStation: "First" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${body.revision}"`,
    });
    expect(first.status).toBe(200);

    const stale = await send("PUT", "/admin/api/settings", { settings: { ...body.settings, originStation: "Second" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${body.revision}"`,
    });
    expect(stale.status).toBe(409);
    const err = await stale.json<{ error: { code: string }; current: { revision: number; settings: { originStation: string } } }>();
    expect(err.error.code).toBe("revision_conflict");
    expect(err.current.settings.originStation).toBe("First");
  });

  it("非法字段 → 422 invalid_settings 带 issues", async () => {
    const body = await getSettings();
    const res = await send("PUT", "/admin/api/settings", { settings: { ...body.settings, notifyCommuteDisruption: "yes" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${body.revision}"`,
    });
    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string }; issues: Array<{ path: string; message: string }> }>();
    expect(err.error.code).toBe("invalid_settings");
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("缺 CSRF 头 → 403", async () => {
    const body = await getSettings();
    const res = await send("PUT", "/admin/api/settings", { settings: body.settings }, { "If-Match": `"r${body.revision}"` });
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/api/export", () => {
  it("Content-Disposition 含 pa-bff-settings- 与 Oslo 日期；不含密钥明文密文", async () => {
    await send("PUT", "/admin/api/secrets/google_routes", { value: "AIzaSyExportTest1234" });

    const res = await get("/admin/api/export");
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("pa-bff-settings-");
    expect(disposition).toMatch(/pa-bff-settings-\d{8}\.json/);

    const text = await res.text();
    expect(text).not.toContain("AIzaSyExportTest1234");
    expect(text).not.toContain("google_routes");
    const body = JSON.parse(text) as { format: string; version: number; revision: number; settings: Record<string, unknown> };
    expect(body.format).toBe("pa-bff-settings");
    expect(body.version).toBe(1);
  });
});

describe("POST /admin/api/import", () => {
  it("合法文件 + 正确 If-Match → revision + 1", async () => {
    const before = await getSettings();
    const exportRes = await get("/admin/api/export");
    const exportBody = await exportRes.json<{ format: string; version: number; exportedAt: string; revision: number; settings: Record<string, unknown> }>();

    const res = await send("POST", "/admin/api/import", { ...exportBody, settings: { ...exportBody.settings, originStation: "Imported" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${before.revision}"`,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ revision: number; settings: { originStation: string } }>();
    expect(body.revision).toBe(before.revision + 1);
    expect(body.settings.originStation).toBe("Imported");
  });

  it("format 错 → 422", async () => {
    const before = await getSettings();
    const res = await send("POST", "/admin/api/import", { format: "wrong", version: 1, exportedAt: new Date().toISOString(), revision: before.revision, settings: before.settings }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${before.revision}"`,
    });
    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("invalid_settings");
  });

  it("version: 2 → 422", async () => {
    const before = await getSettings();
    const res = await send("POST", "/admin/api/import", { format: "pa-bff-settings", version: 2, exportedAt: new Date().toISOString(), revision: before.revision, settings: before.settings }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${before.revision}"`,
    });
    expect(res.status).toBe(422);
  });

  it("旧 If-Match → 409", async () => {
    const before = await getSettings();
    const exportRes = await get("/admin/api/export");
    const exportBody = await exportRes.json<{ format: string; version: number; exportedAt: string; revision: number; settings: Record<string, unknown> }>();

    // 先用正确的 revision 写一次，让原 revision 过期。
    await send("PUT", "/admin/api/settings", { settings: { ...before.settings, originStation: "Bump" } }, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${before.revision}"`,
    });

    const res = await send("POST", "/admin/api/import", exportBody, {
      "X-PA-Admin": "1",
      Origin: "http://localhost",
      "If-Match": `"r${before.revision}"`,
    });
    expect(res.status).toBe(409);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("revision_conflict");
  });

  it("缺 CSRF 头 → 403", async () => {
    const before = await getSettings();
    const res = await send("POST", "/admin/api/import", { format: "pa-bff-settings", version: 1, exportedAt: new Date().toISOString(), revision: before.revision, settings: before.settings }, {
      "If-Match": `"r${before.revision}"`,
    });
    expect(res.status).toBe(403);
  });
});
