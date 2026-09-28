// GET /admin/api/push-log、POST /admin/api/push/test 的集成测试。FCM 端点用
// test/helpers/fcm-mock.ts 假实现，不访问真实网络。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import type { Env } from "../../src/env";
import { resetFcmCacheForTest } from "../../src/notify/fcm";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM secrets");
  await env.DB.exec("DELETE FROM push_log");
  resetFcmCacheForTest();
});

afterEach(() => {
  resetFcmCacheForTest();
  vi.useRealTimers();
});

function adminEnv(): Env {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
    ACCESS_AUD: "test-aud-tag",
    ADMIN_DEV_BYPASS: "1",
  } as unknown as Env;
}

function get(path: string) {
  return app.request(`http://localhost${path}`, {}, adminEnv());
}

function post(path: string, body?: unknown, headers: Record<string, string> = { "X-PA-Admin": "1", Origin: "http://localhost" }) {
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    init.headers = { ...headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(`http://localhost${path}`, init, adminEnv());
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
  const { code } = await codeRes.json<{ code: string }>();
  const redeemRes = await app.request(
    "http://localhost/v1/pair/redeem",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName }) },
    env,
  );
  expect(redeemRes.status).toBe(201);
  return redeemRes.json<{ deviceId: string; token: string }>();
}

async function setPushToken(token: string, pushToken: string): Promise<void> {
  const res = await app.request(
    "http://localhost/v1/devices/me/push-token",
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: pushToken }),
    },
    env,
  );
  expect(res.status).toBe(204);
}

async function putFcmSecret(ownerToken: string, json: string): Promise<void> {
  const res = await app.request(
    "http://localhost/v1/secrets/fcm_service_account",
    { method: "PUT", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ value: json }) },
    env,
  );
  expect(res.status).toBe(200);
}

async function readPushLogCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_log").first<{ n: number }>();
  return row?.n ?? 0;
}

const NOW = new Date("2026-09-26T08:00:00.000Z");

describe("POST /admin/api/push/test", () => {
  it("两台设备 → 2 次 FCM、push_log 一行", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    const viewer = await pairViewer(owner.token);
    await setPushToken(viewer.token, "viewer-token");
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    const google = mockGoogle();

    const res = await post("/admin/api/push/test", {});
    expect(res.status).toBe(200);
    const body = await res.json<{ deviceCount: number; result: { status: string; sent: number } }>();
    expect(body.deviceCount).toBe(2);
    expect(body.result.status).toBe("sent");
    expect(google.fcmCalls).toHaveLength(2);
    expect(await readPushLogCount()).toBe(1);
  });

  it("指定 deviceId → 只发那一台", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    const viewer = await pairViewer(owner.token);
    await setPushToken(viewer.token, "viewer-token");
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    const google = mockGoogle();

    const res = await post("/admin/api/push/test", { deviceId: viewer.deviceId });
    expect(res.status).toBe(200);
    const body = await res.json<{ deviceCount: number }>();
    expect(body.deviceCount).toBe(1);
    expect(google.fcmCalls).toHaveLength(1);
  });

  it("deviceId 不存在 → 404", async () => {
    await claimOwner();
    const res = await post("/admin/api/push/test", { deviceId: "does-not-exist" });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("未配置服务账号 → 503 fcm_not_configured", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    mockGoogle();
    const res = await post("/admin/api/push/test", {});
    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("fcm_not_configured");
  });

  it("先调 /v1/push/test 再调管理接口 → 429（共用 30 秒节流）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);

    const first = await app.request(
      "http://localhost/v1/push/test",
      { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(first.status).toBe(200);

    const second = await post("/admin/api/push/test", {});
    expect(second.status).toBe(429);
    const body = await second.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("too_soon");
  });

  it("缺 CSRF 头 → 403", async () => {
    await claimOwner();
    const res = await post("/admin/api/push/test", {}, {});
    expect(res.status).toBe(403);
  });

  it("非法请求体 → 422 invalid_request", async () => {
    await claimOwner();
    const res = await post("/admin/api/push/test", { deviceId: 123 });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("GET /admin/api/push-log", () => {
  it("result 列写入非法 JSON 的一行 → 该行 result: null，其余正常", async () => {
    await env.DB.prepare("INSERT INTO push_log (at, policy, title, body, device_count, result) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("2026-09-26T08:00:00.000Z", "test", "标题", "内容", 1, "not-json{{{")
      .run();
    await env.DB.prepare("INSERT INTO push_log (at, policy, title, body, device_count, result) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        "2026-09-26T08:05:00.000Z",
        "test",
        "标题2",
        "内容2",
        1,
        JSON.stringify({ status: "sent", reason: null, sent: 1, failed: 0, unregistered: 0, codes: {} }),
      )
      .run();

    const res = await get("/admin/api/push-log");
    expect(res.status).toBe(200);
    const body = await res.json<{ entries: Array<{ result: { status: string } | null }> }>();
    expect(body.entries).toHaveLength(2);
    const [newest, oldest] = body.entries;
    expect(newest?.result?.status).toBe("sent");
    expect(oldest?.result).toBeNull();
  });

  it("缺行为空 → entries 为空数组，nextBefore 为 null", async () => {
    const res = await get("/admin/api/push-log");
    const body = await res.json<{ entries: unknown[]; nextBefore: number | null }>();
    expect(body.entries).toEqual([]);
    expect(body.nextBefore).toBeNull();
  });

  it("limit=101 → 422", async () => {
    const res = await get("/admin/api/push-log?limit=101");
    expect(res.status).toBe(422);
  });
});
