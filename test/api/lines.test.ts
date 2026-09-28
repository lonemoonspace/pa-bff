// GET /v1/lines 的集成测试：走真实 fetch 入口（index.ts → app.ts → lines.ts），出站的
// Entur 请求用 vi.spyOn(globalThis, "fetch") 挡住（见 test/api/stops.test.ts 同样的注释）。
// 测试数据用虚构线路 TST:Line:* 与虚构站 NSR:StopPlace:9000x（P9 通用约定）。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import linesCommon from "../fixtures/entur/lines-common.json";

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
  body: { variables: Record<string, unknown> };
}

function mockFetchOnce(body: unknown, status = 200): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const requestInit = init as RequestInit;
    calls.push({ url: String(url), body: JSON.parse(requestInit.body as string) });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

const STOP_A = "NSR:StopPlace:90001";
const STOP_B = "NSR:StopPlace:90002";

describe("GET /v1/lines", () => {
  it("返回两边都出现的线路，按 id 去重，一次 Entur 请求", async () => {
    const owner = await claimOwner();
    const calls = mockFetchOnce(linesCommon);

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`,
      authed(owner.token),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.variables).toEqual({ stopA: STOP_A, stopB: STOP_B });
    const body = await res.json<{ lines: Array<{ id: string; publicCode: string; transportMode: string }> }>();
    expect(body.lines).toEqual([
      { id: "TST:Line:42", publicCode: "42", name: "Alpha - Beta", transportMode: "bus" },
    ]);
  });

  it("按 transportMode 再按 publicCode（数值）排序", async () => {
    const owner = await claimOwner();
    mockFetchOnce({
      data: {
        stopA: {
          quays: [
            {
              lines: [
                { id: "TST:Line:9", publicCode: "9", name: "Bus 9", transportMode: "bus" },
                { id: "TST:Line:42", publicCode: "42", name: "Bus 42", transportMode: "bus" },
                { id: "TST:Line:R1", publicCode: "R1", name: "Rail 1", transportMode: "rail" },
              ],
            },
          ],
        },
        stopB: {
          quays: [
            {
              lines: [
                { id: "TST:Line:9", publicCode: "9", name: "Bus 9", transportMode: "bus" },
                { id: "TST:Line:42", publicCode: "42", name: "Bus 42", transportMode: "bus" },
                { id: "TST:Line:R1", publicCode: "R1", name: "Rail 1", transportMode: "rail" },
              ],
            },
          ],
        },
      },
    });

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`,
      authed(owner.token),
    );

    const body = await res.json<{ lines: Array<{ id: string }> }>();
    // "9" 与 "42" 按数值排序（9 在 42 前面，不是字符串序），bus 在 rail 前面（transportMode 字典序）。
    expect(body.lines.map((l) => l.id)).toEqual(["TST:Line:9", "TST:Line:42", "TST:Line:R1"]);
  });

  it("任一 stop place 不存在（quays 为 null）→ 空列表", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ data: { stopA: null, stopB: { quays: [{ lines: [{ id: "TST:Line:42" }] }] } } });

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`,
      authed(owner.token),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ lines: unknown[] }>();
    expect(body.lines).toEqual([]);
  });

  it("stopA / stopB 不是 NSR:StopPlace:<数字> → 422 invalid_request，不发外部请求", async () => {
    const owner = await claimOwner();
    const calls = mockFetchOnce({ data: {} });

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=not-a-stop&stopB=${STOP_B}`,
      authed(owner.token),
    );

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("缺少参数 → 422 invalid_request", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ data: {} });

    const res = await SELF.fetch(`https://bff.example/v1/lines?stopA=${STOP_A}`, authed(owner.token));

    expect(res.status).toBe(422);
  });

  it("Entur 返回 GraphQL errors → 502 upstream_error", async () => {
    const owner = await claimOwner();
    mockFetchOnce({ data: null, errors: [{ message: "boom" }] });

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`,
      authed(owner.token),
    );

    expect(res.status).toBe(502);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe("upstream_error");
  });

  it("Entur 请求失败（HTTP 500）→ 502 upstream_error", async () => {
    const owner = await claimOwner();
    mockFetchOnce("server error", 500);

    const res = await SELF.fetch(
      `https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`,
      authed(owner.token),
    );

    expect(res.status).toBe(502);
  });

  it("未认证 → 401", async () => {
    mockFetchOnce({ data: {} });

    const res = await SELF.fetch(`https://bff.example/v1/lines?stopA=${STOP_A}&stopB=${STOP_B}`);

    expect(res.status).toBe(401);
  });
});
