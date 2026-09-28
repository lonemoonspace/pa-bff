// GET /v1/stops/search 的集成测试：走真实 fetch 入口（index.ts → app.ts → stops.ts），
// 出站的 Entur 请求用 vi.spyOn(globalThis, "fetch") 挡住（见 test/sources/http.test.ts
// 顶部注释：这个版本的 vitest-pool-workers 没有导出 fetchMock）。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import stopsAsker from "../fixtures/entur/stops-asker.json";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
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

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  };
}

interface RecordedCall {
  url: string;
}

function mockFetchOnce(body: unknown, status = 200): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    calls.push({ url: String(url) });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

describe("GET /v1/stops/search", () => {
  it("只保留 NSR:StopPlace: 开头的结果，映射为 { id, name, locality }", async () => {
    const owner = await claimOwner();
    const calls = mockFetchOnce(stopsAsker);

    const res = await SELF.fetch("https://bff.example/v1/stops/search?q=Asker", authed(owner.token));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("layers=venue");
    expect(calls[0]!.url).toContain("text=Asker");
    const body = await res.json<{ stops: Array<{ id: string; name: string; locality: string | null }> }>();
    expect(body.stops).toEqual([
      { id: "NSR:StopPlace:418", name: "Asker stasjon", locality: "Asker" },
      { id: "NSR:StopPlace:59616", name: "Asker skole", locality: "Asker" },
      { id: "NSR:StopPlace:99999", name: "Askerveien", locality: null },
    ]);
  });

  it("最多返回 10 条", async () => {
    const owner = await claimOwner();
    const features = Array.from({ length: 15 }, (_, i) => ({
      properties: { id: `NSR:StopPlace:${i}`, name: `Stop ${i}`, locality: "Oslo" },
    }));
    mockFetchOnce({ features });

    const res = await SELF.fetch("https://bff.example/v1/stops/search?q=Oslo", authed(owner.token));

    const body = await res.json<{ stops: unknown[] }>();
    expect(body.stops).toHaveLength(10);
  });

  it("q 长度小于 2 → 422 invalid_query，不发外部请求", async () => {
    const owner = await claimOwner();
    const calls = mockFetchOnce({ features: [] });

    const res = await SELF.fetch("https://bff.example/v1/stops/search?q=a", authed(owner.token));

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("invalid_query");
    expect(calls).toHaveLength(0);
  });

  it("q 长度超过 60 → 422 invalid_query", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ features: [] });

    const res = await SELF.fetch(`https://bff.example/v1/stops/search?q=${"a".repeat(61)}`, authed(owner.token));

    expect(res.status).toBe(422);
  });

  it("缺少 q → 422 invalid_query", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ features: [] });

    const res = await SELF.fetch("https://bff.example/v1/stops/search", authed(owner.token));

    expect(res.status).toBe(422);
  });

  it("未认证 → 401", async () => {
    mockFetchOnce({ features: [] });

    const res = await SELF.fetch("https://bff.example/v1/stops/search?q=Asker");

    expect(res.status).toBe(401);
  });

  it("上游返回空结果 → { stops: [] }", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ features: [] });

    const res = await SELF.fetch("https://bff.example/v1/stops/search?q=nowhere", authed(owner.token));

    expect(res.status).toBe(200);
    const body = await res.json<{ stops: unknown[] }>();
    expect(body.stops).toEqual([]);
  });
});
