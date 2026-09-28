// /v1/secrets* 的集成测试：走真实 fetch 入口（index.ts → app.ts → secrets.ts）。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTester } from "../../src/secrets/testers";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";
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
  return {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  };
}

const SECRET_VALUE = "AIzaSyTest12345";

describe("GET /v1/secrets", () => {
  it("owner 可读，响应体不含明文与密文，未写入的密钥为 missing", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch("https://bff.example/v1/secrets", authed(owner.token));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as { secrets: Array<{ name: string; state: string }> };
    expect(body.secrets).toHaveLength(3);
    expect(body.secrets.every((s) => s.state === "missing")).toBe(true);
  });

  it("viewer → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const res = await SELF.fetch("https://bff.example/v1/secrets", authed(viewer.token));
    expect(res.status).toBe(403);
  });
});

describe("PUT /v1/secrets/:name", () => {
  it("保存成功，响应体不含明文密文，PUT 后立即测试", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as {
      name: string;
      state: string;
      hint: string;
      lastTest: { ok: boolean; message: string };
    };
    expect(body.state).toBe("present");
    expect(body.hint).toBe("···2345");
    expect(body.lastTest.message).toBe("尚不支持测试");
  });

  it("fcm_service_account 值不是含 project_id/client_email/private_key 的 JSON → 422 invalid_value", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/fcm_service_account",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "not-a-service-account" }),
      }),
    );
    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("invalid_value");
  });

  it("fcm_service_account 缺 project_id → 422 invalid_value", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/fcm_service_account",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" }),
        }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("fcm_service_account 完整 JSON → 200，PUT 后立即测试拿到访问令牌，响应体不含私钥", async () => {
    const owner = await claimOwner();
    const { json, sa } = await makeTestServiceAccount();
    mockGoogle();

    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/fcm_service_account",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: json }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(sa.private_key);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("test-access-token");
    const body = JSON.parse(text) as { state: string; lastTest: { ok: boolean; message: string } };
    expect(body.state).toBe("present");
    expect(body.lastTest.ok).toBe(true);
    expect(body.lastTest.message).toContain(sa.project_id);
  });

  it("未知 name → 404", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/unknown_thing",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("viewer → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(viewer.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("换 MASTER_KEY 后 GET /v1/secrets 状态变为 unreadable", async () => {
    const owner = await claimOwner();
    const putRes = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
    );
    expect(putRes.status).toBe(200);

    const original = env.MASTER_KEY;
    env.MASTER_KEY = "qFB4cnGQDOVhQdsMfCF43cXV67KNail+S8+2dkwc4jw=";
    try {
      const res = await SELF.fetch("https://bff.example/v1/secrets", authed(owner.token));
      const body = await res.json<{ secrets: Array<{ name: string; state: string }> }>();
      expect(body.secrets.find((s) => s.name === "google_routes")?.state).toBe("unreadable");
    } finally {
      env.MASTER_KEY = original;
    }
  });
});

describe("DELETE /v1/secrets/:name", () => {
  it("删除后状态变回 missing", async () => {
    const owner = await claimOwner();
    await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
    );
    const delRes = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(owner.token, { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    const listRes = await SELF.fetch("https://bff.example/v1/secrets", authed(owner.token));
    const body = await listRes.json<{ secrets: Array<{ name: string; state: string }> }>();
    expect(body.secrets.find((s) => s.name === "google_routes")?.state).toBe("missing");
  });

  it("未知 name → 404", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/unknown_thing",
      authed(owner.token, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  it("viewer → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(viewer.token, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/secrets/:name/test", () => {
  it("重新测试已保存的密钥", async () => {
    const owner = await claimOwner();
    await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes",
      authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
    );

    registerTester("google_routes", async () => ({ ok: true, message: "可用" }));
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes/test",
      authed(owner.token, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as { lastTest: { ok: boolean; message: string; at: string } };
    expect(body.lastTest.ok).toBe(true);
    expect(body.lastTest.message).toBe("可用");
  });

  it("未知 name → 404", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/unknown_thing/test",
      authed(owner.token, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  it("viewer → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const res = await SELF.fetch(
      "https://bff.example/v1/secrets/google_routes/test",
      authed(viewer.token, { method: "POST" }),
    );
    expect(res.status).toBe(403);
  });
});
