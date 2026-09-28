// GET/PUT/DELETE /admin/api/secrets*、POST /admin/api/secrets/:name/test 的集成测试。
// 用本地开发旁路（ADMIN_DEV_BYPASS=1 + localhost）跳过 Access JWT 签发的麻烦——T7.1 已经
// 把该旁路本身测过了；/v1 的对应行为已在 test/api/secrets.test.ts 覆盖，这里只关心管理
// 接口自己的路由 / 状态码映射。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { registerTester } from "../../src/secrets/testers";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";
import type { Env } from "../../src/env";
import "../../src/notify/fcm";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM secrets");
  registerTester("google_routes", async () => ({ ok: false, message: "尚不支持测试" }));
});

afterEach(() => {
  vi.restoreAllMocks();
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

const SECRET_VALUE = "AIzaSyAdminTest12345";

describe("GET /admin/api/secrets", () => {
  it("未写入时全部 missing", async () => {
    const res = await get("/admin/api/secrets");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as { secrets: Array<{ name: string; state: string }> };
    expect(body.secrets).toHaveLength(3);
    expect(body.secrets.every((s) => s.state === "missing")).toBe(true);
  });
});

describe("PUT /admin/api/secrets/:name", () => {
  it("保存成功，响应体不含明文密文，PUT 后立即测试", async () => {
    const res = await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as { state: string; hint: string; lastTest: { message: string } };
    expect(body.state).toBe("present");
    expect(body.lastTest.message).toBe("尚不支持测试");
  });

  it("fcm_service_account 非法 JSON → 422 invalid_value", async () => {
    const res = await send("PUT", "/admin/api/secrets/fcm_service_account", { value: "not-a-service-account" });
    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("invalid_value");
  });

  it("fcm_service_account 完整 JSON → 200，响应体不含私钥", async () => {
    const { json, sa } = await makeTestServiceAccount();
    mockGoogle();
    const res = await send("PUT", "/admin/api/secrets/fcm_service_account", { value: json });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(sa.private_key);
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("未知 name → 404", async () => {
    const res = await send("PUT", "/admin/api/secrets/unknown_thing", { value: "x" });
    expect(res.status).toBe(404);
  });

  it("缺 CSRF 头 → 403", async () => {
    const res = await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE }, {});
    expect(res.status).toBe(403);
  });
});

describe("DELETE /admin/api/secrets/:name", () => {
  it("删除后状态变回 missing", async () => {
    await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE });
    const delRes = await send("DELETE", "/admin/api/secrets/google_routes");
    expect(delRes.status).toBe(204);

    const res = await get("/admin/api/secrets");
    const body = await res.json<{ secrets: Array<{ name: string; state: string }> }>();
    expect(body.secrets.find((s) => s.name === "google_routes")?.state).toBe("missing");
  });

  it("未知 name → 404", async () => {
    const res = await send("DELETE", "/admin/api/secrets/unknown_thing");
    expect(res.status).toBe(404);
  });

  it("缺 CSRF 头 → 403", async () => {
    await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE });
    const res = await send("DELETE", "/admin/api/secrets/google_routes", undefined, {});
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/secrets/:name/test", () => {
  it("重新测试已保存的密钥", async () => {
    await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE });
    registerTester("google_routes", async () => ({ ok: true, message: "可用" }));

    const res = await send("POST", "/admin/api/secrets/google_routes/test");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as { lastTest: { ok: boolean; message: string } };
    expect(body.lastTest.ok).toBe(true);
    expect(body.lastTest.message).toBe("可用");
  });

  it("未知 name → 404", async () => {
    const res = await send("POST", "/admin/api/secrets/unknown_thing/test");
    expect(res.status).toBe(404);
  });

  it("缺 CSRF 头 → 403", async () => {
    await send("PUT", "/admin/api/secrets/google_routes", { value: SECRET_VALUE });
    const res = await send("POST", "/admin/api/secrets/google_routes/test", undefined, {});
    expect(res.status).toBe(403);
  });
});
