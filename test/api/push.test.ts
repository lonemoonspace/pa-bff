// POST /v1/push/test 的集成测试：走真实 fetch 入口（index.ts → app.ts → push.ts）。
// FCM 端点用 test/helpers/fcm-mock.ts 假实现，不访问真实网络。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

async function claimOwner(deviceName = "owner-phone"): Promise<{ deviceId: string; token: string }> {
  const res = await SELF.fetch("https://bff.example/v1/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimCode: env.CLAIM_CODE, deviceName }),
  });
  expect(res.status).toBe(201);
  return res.json<{ deviceId: string; token: string }>();
}

async function pairViewer(ownerToken: string, deviceName = "viewer-tablet"): Promise<{ deviceId: string; token: string }> {
  const codeRes = await SELF.fetch("https://bff.example/v1/devices/pair-codes", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(codeRes.status).toBe(201);
  const { code } = await codeRes.json<{ code: string; expiresAt: string }>();

  const redeemRes = await SELF.fetch("https://bff.example/v1/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });
  expect(redeemRes.status).toBe(201);
  return redeemRes.json<{ deviceId: string; token: string }>();
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } };
}

async function setPushToken(token: string, pushToken = "fake-fcm-token"): Promise<void> {
  const res = await SELF.fetch(
    "https://bff.example/v1/devices/me/push-token",
    authed(token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: pushToken }),
    }),
  );
  expect(res.status).toBe(204);
}

async function putFcmSecret(ownerToken: string, json: string): Promise<void> {
  const res = await SELF.fetch(
    "https://bff.example/v1/secrets/fcm_service_account",
    authed(ownerToken, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: json }),
    }),
  );
  expect(res.status).toBe(200);
}

async function readPushLogCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_log").first<{ n: number }>();
  return row?.n ?? 0;
}

const NOW = new Date("2026-09-26T08:00:00.000Z");

describe("POST /v1/push/test", () => {
  it("未认证 → 401", async () => {
    const res = await SELF.fetch("https://bff.example/v1/push/test", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("viewer 调用 → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(viewer.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );

    expect(res.status).toBe(403);
  });

  it("非法请求体 → 422 invalid_request", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "everyone" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("invalid_request");
  });

  it("self 且本机无 push token → 409 no_push_token，且不发外部请求", async () => {
    const owner = await claimOwner();
    const sa = await makeTestServiceAccount();
    mockGoogle(); // putFcmSecret 会触发一次 tester 调用，先给它一个能用的假端点
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    const google = mockGoogle();

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("no_push_token");
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
  });

  it("未配置服务账号 → 503 fcm_not_configured", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token);
    const google = mockGoogle();

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("fcm_not_configured");
    expect(google.fcmCalls).toHaveLength(0);
  });

  it("scope=all 且两台设备 → 200，2 次 FCM，push_log 一行", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    const viewer = await pairViewer(owner.token);
    await setPushToken(viewer.token, "viewer-token");
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    const google = mockGoogle();

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ deviceCount: number; result: { status: string; sent: number } }>();
    expect(body.deviceCount).toBe(2);
    expect(body.result.status).toBe("sent");
    expect(body.result.sent).toBe(2);
    expect(google.oauthCalls).toHaveLength(1);
    expect(google.fcmCalls).toHaveLength(2);
    expect(await readPushLogCount()).toBe(1);
    const row = await env.DB.prepare("SELECT policy FROM push_log LIMIT 1").first<{ policy: string }>();
    expect(row?.policy).toBe("test");
    expect(JSON.stringify(body)).not.toContain("owner-token");
    expect(JSON.stringify(body)).not.toContain("viewer-token");
  });

  it("scope=self 只发本机，不发给另一台设备", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token, "owner-token");
    const viewer = await pairViewer(owner.token);
    await setPushToken(viewer.token, "viewer-token");
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    const google = mockGoogle();

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ deviceCount: number; result: { status: string; sent: number } }>();
    expect(body.deviceCount).toBe(1);
    expect(body.result.sent).toBe(1);
    expect(google.fcmCalls).toHaveLength(1);
  });

  it("oauth 400 → 200 且 result.reason = fcm_auth_failed", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token);
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);
    resetFcmCacheForTest();
    mockGoogle({
      oauth: () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }),
    });

    const res = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { status: string; reason: string | null } }>();
    expect(body.result.status).toBe("skipped");
    expect(body.result.reason).toBe("fcm_auth_failed");
  });

  it("30 秒内第二次 → 429 too_soon；31 秒后可再发", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const owner = await claimOwner();
    await setPushToken(owner.token);
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);

    const first = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(first.status).toBe(200);

    const second = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(second.status).toBe(429);
    const secondBody = await second.json<{ error: { code: string } }>();
    expect(secondBody.error.code).toBe("too_soon");

    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    const third = await SELF.fetch(
      "https://bff.example/v1/push/test",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(third.status).toBe(200);
  });

  it("并发两次请求只有一个成功", async () => {
    const owner = await claimOwner();
    await setPushToken(owner.token);
    const sa = await makeTestServiceAccount();
    mockGoogle();
    await putFcmSecret(owner.token, sa.json);

    const make = () =>
      SELF.fetch(
        "https://bff.example/v1/push/test",
        authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      );
    const [a, b] = await Promise.all([make(), make()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
  });
});
