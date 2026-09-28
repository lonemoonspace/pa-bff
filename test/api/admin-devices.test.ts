// GET/DELETE/PATCH /admin/api/devices*、POST /admin/api/pair-codes 的集成测试。
// 用本地开发旁路（ADMIN_DEV_BYPASS=1 + localhost）跳过 Access JWT 签发的麻烦——T7.1 已经把
// 该旁路本身测过了；/v1 的对应行为已在 test/api/devices.test.ts 覆盖，这里只关心管理接口
// 自己的路由 / 状态码映射，以及「管理员生成的配对码可被 /v1/pair/redeem 兑换」这类跨接口行为。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import type { Env } from "../../src/env";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
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

async function claimOwner(deviceName = "owner-phone"): Promise<{ deviceId: string; token: string }> {
  const res = await app.request(
    "http://localhost/v1/claim",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimCode: env.CLAIM_CODE, deviceName }) },
    env,
  );
  expect(res.status).toBe(201);
  return res.json<{ deviceId: string; token: string }>();
}

async function pairViewer(ownerToken: string, deviceName = "viewer-tablet"): Promise<{ deviceId: string; token: string }> {
  const codeRes = await app.request(
    "http://localhost/v1/devices/pair-codes",
    { method: "POST", headers: { authorization: `Bearer ${ownerToken}` } },
    env,
  );
  expect(codeRes.status).toBe(201);
  const { code } = await codeRes.json<{ code: string; expiresAt: string }>();

  const redeemRes = await app.request(
    "http://localhost/v1/pair/redeem",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName }) },
    env,
  );
  expect(redeemRes.status).toBe(201);
  return redeemRes.json<{ deviceId: string; token: string }>();
}

async function promoteToOwner(ownerToken: string, targetId: string): Promise<void> {
  const res = await app.request(
    `http://localhost/v1/devices/${targetId}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    },
    env,
  );
  expect(res.status).toBe(200);
}

describe("GET /admin/api/devices", () => {
  it("列出未吊销的设备，不含 self 字段", async () => {
    await claimOwner("我的手机");
    const res = await get("/admin/api/devices");
    expect(res.status).toBe(200);
    const body = await res.json<{ devices: Array<Record<string, unknown>> }>();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).not.toHaveProperty("self");
    expect(body.devices[0]?.role).toBe("owner");
  });
});

describe("DELETE /admin/api/devices/:id", () => {
  it("不存在的设备 → 404", async () => {
    const res = await send("DELETE", "/admin/api/devices/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("删除最后一个有效 owner → 409 last_owner", async () => {
    const owner = await claimOwner();
    const res = await send("DELETE", `/admin/api/devices/${owner.deviceId}`);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("last_owner");
  });

  it("删除设备后，它生成的未用配对码失效", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    await promoteToOwner(owner.token, viewer.deviceId);

    const codeRes = await app.request(
      "http://localhost/v1/devices/pair-codes",
      { method: "POST", headers: { authorization: `Bearer ${owner.token}` } },
      env,
    );
    const { code } = await codeRes.json<{ code: string }>();

    const del = await send("DELETE", `/admin/api/devices/${owner.deviceId}`);
    expect(del.status).toBe(204);

    const redeem = await app.request(
      "http://localhost/v1/pair/redeem",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "太晚了" }) },
      env,
    );
    expect(redeem.status).toBe(401);
  });

  it("缺 CSRF 头 → 403", async () => {
    const owner = await claimOwner();
    const res = await send("DELETE", `/admin/api/devices/${owner.deviceId}`, undefined, {});
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("csrf_rejected");
  });
});

describe("PATCH /admin/api/devices/:id", () => {
  it("非法请求体 → 422 invalid_request", async () => {
    const owner = await claimOwner();
    const res = await send("PATCH", `/admin/api/devices/${owner.deviceId}`, { role: "not_a_role" });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("invalid_request");
  });

  it("降级最后一个 owner → 409 last_owner", async () => {
    const owner = await claimOwner();
    const res = await send("PATCH", `/admin/api/devices/${owner.deviceId}`, { role: "viewer" });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("last_owner");
  });

  it("有两个 owner 时可以降级其中一个，返回不含 self 的设备对象", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    await promoteToOwner(owner.token, viewer.deviceId);

    const res = await send("PATCH", `/admin/api/devices/${viewer.deviceId}`, { role: "viewer" });
    expect(res.status).toBe(200);
    const body = await res.json<{ role: string; self?: unknown }>();
    expect(body.role).toBe("viewer");
    expect(body).not.toHaveProperty("self");
  });

  it("缺 CSRF 头 → 403", async () => {
    const owner = await claimOwner();
    const res = await send("PATCH", `/admin/api/devices/${owner.deviceId}`, { role: "viewer" }, {});
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/pair-codes", () => {
  it("created_by 为 admin:<email>，能被 /v1/pair/redeem 兑换", async () => {
    await claimOwner();
    const res = await send("POST", "/admin/api/pair-codes");
    expect(res.status).toBe(201);
    const body = await res.json<{ code: string; expiresAt: string }>();

    const row = await env.DB.prepare("SELECT created_by FROM pair_codes WHERE code_hash = (SELECT code_hash FROM pair_codes LIMIT 1)").first<{
      created_by: string;
    }>();
    expect(row?.created_by).toBe("admin:dev@localhost");

    const redeem = await app.request(
      "http://localhost/v1/pair/redeem",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: body.code, deviceName: "新设备" }) },
      env,
    );
    expect(redeem.status).toBe(201);
  });

  it("缺 CSRF 头 → 403", async () => {
    await claimOwner();
    const res = await send("POST", "/admin/api/pair-codes", undefined, {});
    expect(res.status).toBe(403);
  });
});
