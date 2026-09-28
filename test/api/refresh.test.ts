// POST /v1/refresh 的集成测试：走真实 fetch 入口（index.ts → app.ts → refresh.ts）。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM jobs");
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

async function insertJob(name: string, nextRunAt: string): Promise<void> {
  await env.DB.prepare("INSERT INTO jobs (name, next_run_at, fail_count) VALUES (?, ?, 0)").bind(name, nextRunAt).run();
}

async function jobNextRunAt(name: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE name = ?").bind(name).first<{
    next_run_at: string | null;
  }>();
  return row?.next_run_at ?? null;
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

describe("POST /v1/refresh", () => {
  it("未认证 → 401", async () => {
    const res = await SELF.fetch("https://bff.example/v1/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("viewer 调用 → 403 forbidden", async () => {
    const owner = await claimOwner();
    const viewer = await pairViewer(owner.token);

    const res = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(viewer.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );

    expect(res.status).toBe(403);
  });

  it("不带 sources 时默认刷新全部已知任务，含 train", async () => {
    const owner = await claimOwner();
    await insertJob("weather", FAR_FUTURE);
    await insertJob("train", FAR_FUTURE);
    await insertJob("traffic_outbound", FAR_FUTURE);
    await insertJob("traffic_return", FAR_FUTURE);
    await insertJob("bus", FAR_FUTURE);
    await insertJob("football", FAR_FUTURE);

    const res = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );

    expect(res.status).toBe(202);
    const body = await res.json<{ queued: string[] }>();
    // T4.4：train 现在有对应任务处理器（jobs/train.ts），queued 应该包含它。
    expect(body.queued.sort()).toEqual(
      ["weather", "train", "trafficOutbound", "trafficReturn", "bus", "football"].sort(),
    );
    for (const name of ["weather", "train", "traffic_outbound", "traffic_return", "bus", "football"]) {
      expect(await jobNextRunAt(name)).not.toBe(FAR_FUTURE);
    }
  });

  it("只指定 sources 里的任务会被刷新，其它任务不受影响", async () => {
    const owner = await claimOwner();
    await insertJob("weather", FAR_FUTURE);
    await insertJob("bus", FAR_FUTURE);

    const res = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: ["bus"] }),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json<{ queued: string[] }>();
    expect(body.queued).toEqual(["bus"]);
    expect(await jobNextRunAt("bus")).not.toBe(FAR_FUTURE);
    expect(await jobNextRunAt("weather")).toBe(FAR_FUTURE);
  });

  it("sources 里只有 train 时，只刷新 train，不影响其它任务", async () => {
    const owner = await claimOwner();
    await insertJob("weather", FAR_FUTURE);
    await insertJob("train", FAR_FUTURE);

    const res = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: ["train"] }),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json<{ queued: string[] }>();
    expect(body.queued).toEqual(["train"]);
    expect(await jobNextRunAt("train")).not.toBe(FAR_FUTURE);
    expect(await jobNextRunAt("weather")).toBe(FAR_FUTURE);
  });

  // F7：请求了某个来源，但 jobs 表里还没有那一行（UPDATE 实际影响 0 行）时，不该假装
  // 已经排上队——queued 应该只反映真正成功设置了 next_run_at 的来源。
  it("请求的来源在 jobs 表里还没有对应行时，不出现在 queued 里", async () => {
    const owner = await claimOwner();
    // 故意不 insertJob("bus", ...)：jobs 表里没有这一行。

    const res = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: ["bus"] }),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json<{ queued: string[] }>();
    expect(body.queued).toEqual([]);
  });

  it("每分钟最多一次：第二次请求 → 429 too_soon", async () => {
    const owner = await claimOwner();

    const first = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(first.status).toBe(202);

    const second = await SELF.fetch(
      "https://bff.example/v1/refresh",
      authed(owner.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );

    expect(second.status).toBe(429);
    const body = await second.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("too_soon");
  });
});
