// GET/PUT /v1/settings 的集成测试：走真实 fetch 入口（index.ts → app.ts → settings.ts）。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  // settings 是单行表，重置回迁移里的初始值，避免测试间互相影响 revision。
  await env.DB.exec(
    "UPDATE settings SET json = '{\"originAddress\":\"\",\"destinationAddress\":\"\",\"originStation\":\"Spikkestad\",\"destStation\":\"Nationaltheatret\",\"workWindowStart\":\"07:00\",\"workWindowEnd\":\"10:00\",\"returnWindowStart\":\"14:00\",\"returnWindowEnd\":\"16:00\",\"notifyCommuteDisruption\":false,\"notifyFootballMatch\":false,\"notifyMorningBrief\":false,\"transitPassUntil\":\"\",\"parkingPassUntil\":\"\",\"notifyTicketExpiry\":false}', revision = 1, updated_at = '2026-01-01T00:00:00.000Z', updated_by = NULL WHERE id = 1",
  );
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

async function getSettings(token: string) {
  const res = await SELF.fetch("https://bff.example/v1/settings", authed(token));
  expect(res.status).toBe(200);
  const body = await res.json<{ revision: number; settings: Record<string, unknown>; updatedAt: string }>();
  return { res, body };
}

describe("GET /v1/settings", () => {
  it("任意设备可读，返回 ETag: \"r<revision>\"", async () => {
    const owner = await claimOwner();
    const { res, body } = await getSettings(owner.token);
    expect(res.headers.get("ETag")).toBe(`"r${body.revision}"`);
    expect(body.revision).toBe(1);
  });
});

describe("PUT /v1/settings", () => {
  it("无 If-Match → 428 precondition_required", async () => {
    const owner = await claimOwner();
    const { body } = await getSettings(owner.token);
    const res = await SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { ...body.settings, originStation: "Asker" } }),
    }));
    expect(res.status).toBe(428);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("precondition_required");
  });

  it("过期 revision → 409 revision_conflict，体里带 current", async () => {
    const owner = await claimOwner();
    const { body } = await getSettings(owner.token);

    const first = await SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
      body: JSON.stringify({ settings: { ...body.settings, originStation: "First" } }),
    }));
    expect(first.status).toBe(200);

    // 用同一个（已过期的）revision 再写一次。
    const stale = await SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
      body: JSON.stringify({ settings: { ...body.settings, originStation: "Second" } }),
    }));
    expect(stale.status).toBe(409);
    const err = await stale.json<{ error: { code: string }; current: { revision: number; settings: { originStation: string } } }>();
    expect(err.error.code).toBe("revision_conflict");
    expect(err.current.settings.originStation).toBe("First");
    expect(err.current.revision).toBe(body.revision + 1);
  });

  it("并发两次 PUT 同一 revision，只有一个成功", async () => {
    const owner = await claimOwner();
    const { body } = await getSettings(owner.token);

    const [a, b] = await Promise.all([
      SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
        body: JSON.stringify({ settings: { ...body.settings, originStation: "A" } }),
      })),
      SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
        method: "PUT",
        headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
        body: JSON.stringify({ settings: { ...body.settings, originStation: "B" } }),
      })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("非法字段 → 422 invalid_settings", async () => {
    const owner = await claimOwner();
    const { body } = await getSettings(owner.token);
    const res = await SELF.fetch("https://bff.example/v1/settings", authed(owner.token, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
      body: JSON.stringify({ settings: { ...body.settings, notifyCommuteDisruption: "yes" } }),
    }));
    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string }; issues: Array<{ path: string; message: string }> }>();
    expect(err.error.code).toBe("invalid_settings");
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("viewer PUT → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);
    const { body } = await getSettings(owner.token);
    const res = await SELF.fetch("https://bff.example/v1/settings", authed(viewer.token, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": `"r${body.revision}"` },
      body: JSON.stringify({ settings: { ...body.settings, originStation: "Asker" } }),
    }));
    expect(res.status).toBe(403);
  });
});
