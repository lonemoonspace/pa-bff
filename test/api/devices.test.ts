// /v1/devices*、requireDevice() / requireOwner() 中间件的集成测试：走真实 fetch 入口
// （index.ts → app.ts → devices.ts），覆盖角色权限、吊销、最后一个 owner 保护、push token。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
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

describe("requireDevice() / requireOwner()", () => {
  it("缺少 Authorization → 401 unauthorized", async () => {
    const res = await SELF.fetch("https://bff.example/v1/devices");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("unauthorized");
  });

  it("viewer 调 owner 接口 → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const res = await SELF.fetch("https://bff.example/v1/devices", authed(viewer.token));
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("forbidden");
  });

  it("吊销后再请求 → 401 revoked", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);

    const del = await SELF.fetch(`https://bff.example/v1/devices/${viewer.deviceId}`, authed(owner.token, { method: "DELETE" }));
    expect(del.status).toBe(204);

    const res = await SELF.fetch("https://bff.example/v1/devices/me/push-token", authed(viewer.token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fcm-token" }),
    }));
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("revoked");
  });
});

describe("GET /v1/devices", () => {
  it("owner 能看到自己，self=true", async () => {
    const owner = await claimOwner("我的手机");
    const res = await SELF.fetch("https://bff.example/v1/devices", authed(owner.token));
    expect(res.status).toBe(200);
    const body = await res.json<{ devices: Array<{ id: string; self: boolean; role: string }> }>();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.id).toBe(owner.deviceId);
    expect(body.devices[0]?.self).toBe(true);
    expect(body.devices[0]?.role).toBe("owner");
  });
});

describe("DELETE /v1/devices/:id", () => {
  it("不存在的设备 → 404", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch("https://bff.example/v1/devices/does-not-exist", authed(owner.token, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  it("G2 修复 4：唯一 owner 删除自己 → 409 last_owner，且该设备仍然有效", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(`https://bff.example/v1/devices/${owner.deviceId}`, authed(owner.token, { method: "DELETE" }));
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("last_owner");

    // 仍然有效：用它的令牌还能正常请求。
    const still = await SELF.fetch("https://bff.example/v1/devices", authed(owner.token));
    expect(still.status).toBe(200);
  });

  it("G2 修复 4：DELETE 同时作废该设备生成的未使用配对码", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    // 把 viewer 提升为第二个 owner，这样删除第一个 owner 不会触发 last_owner 保护。
    await SELF.fetch(`https://bff.example/v1/devices/${viewer.deviceId}`, authed(owner.token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    }));

    const codeRes = await SELF.fetch("https://bff.example/v1/devices/pair-codes", authed(owner.token, { method: "POST" }));
    const { code } = await codeRes.json<{ code: string }>();

    const del = await SELF.fetch(`https://bff.example/v1/devices/${owner.deviceId}`, authed(viewer.token, { method: "DELETE" }));
    expect(del.status).toBe(204);

    const redeem = await SELF.fetch("https://bff.example/v1/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "太晚了" }),
    });
    expect(redeem.status).toBe(401);
  });
});

describe("PATCH /v1/devices/:id", () => {
  it("降级最后一个 owner → 409 last_owner", async () => {
    const owner = await claimOwner();
    const res = await SELF.fetch(`https://bff.example/v1/devices/${owner.deviceId}`, authed(owner.token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("last_owner");
  });

  it("有两个 owner 时可以降级其中一个", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    // 先把 viewer 提升为第二个 owner。
    const promote = await SELF.fetch(`https://bff.example/v1/devices/${viewer.deviceId}`, authed(owner.token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    }));
    expect(promote.status).toBe(200);

    const demote = await SELF.fetch(`https://bff.example/v1/devices/${owner.deviceId}`, authed(viewer.token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }));
    expect(demote.status).toBe(200);
    const body = await demote.json<{ role: string }>();
    expect(body.role).toBe("viewer");
  });

  it("G2 修复 4：两个 owner 并发互相降级 → 至少剩 1 个 owner", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const promote = await SELF.fetch(`https://bff.example/v1/devices/${viewer.deviceId}`, authed(owner.token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    }));
    expect(promote.status).toBe(200);

    const [a, b] = await Promise.all([
      SELF.fetch(`https://bff.example/v1/devices/${viewer.deviceId}`, authed(owner.token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      })),
      SELF.fetch(`https://bff.example/v1/devices/${owner.deviceId}`, authed(viewer.token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      })),
    ]);
    const statuses = [a.status, b.status].sort();
    // 一个成功降级（200）。另一个被挡住：可能是数据库层面的 409 last_owner（真正并发时），
    // 也可能是先完成的那次请求已经落库、第二次请求自己的 requireOwner() 中间件先一步
    // 发现自己不再是 owner 而给出 403（workerd 里两次 fetch 不一定严格并发交错执行）。
    // 两种情况都说明「不会把最后一个 owner 也降级掉」这条不变量成立。
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);

    // 直接查库确认（两个令牌里哪个还是 owner 取决于并发胜负，不确定用哪个去调 GET /v1/devices）。
    const owners = await env.DB.prepare(
      "SELECT id FROM devices WHERE role = 'owner' AND revoked_at IS NULL",
    ).all();
    expect(owners.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PUT /v1/devices/me/push-token", () => {
  it("保存后 GET /v1/devices 的 hasPushToken 变 true，且不返回明文", async () => {
    const owner = await claimOwner();
    const put = await SELF.fetch("https://bff.example/v1/devices/me/push-token", authed(owner.token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fcm-registration-token" }),
    }));
    expect(put.status).toBe(204);

    const res = await SELF.fetch("https://bff.example/v1/devices", authed(owner.token));
    const body = await res.json<{ devices: Array<{ hasPushToken: boolean }> }>();
    expect(body.devices[0]?.hasPushToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain("fcm-registration-token");
  });
});
