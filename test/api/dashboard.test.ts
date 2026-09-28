// GET /v1/dashboard 的集成测试：走真实 fetch 入口（index.ts → app.ts → dashboard.ts）。
// 数据源本身不在这里跑（那是各 jobs/*.test.ts 的事），这里直接用 snapshot.putSuccess /
// putState 摆好快照，只验证信封组装、ETag/304、自检与 configKey 缺省行为。
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import * as snapshot from "../../src/snapshot/store";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM snapshots");
  // [gate] P9：originStation / destStation 默认值改为空串；这里显式选好一对车站
  // （站名与 test/golden/train.test.ts 保持一致，避开 P9 通用约定禁用的旧卡片站名），
  // 让依赖「已选择车站」的用例保持可用。同理关注线路六个字段也显式填好（虚构线路与站，
  // 与 test/jobs/bus.test.ts 一致），让「bus 快照存在」两条用例能算出非 null 的 configKey。
  await env.DB.exec(
    "UPDATE settings SET json = '{\"originAddress\":\"\",\"destinationAddress\":\"\",\"originStation\":\"Spikkestad\",\"destStation\":\"Sandvika\",\"workWindowStart\":\"07:00\",\"workWindowEnd\":\"10:00\",\"returnWindowStart\":\"14:00\",\"returnWindowEnd\":\"16:00\",\"notifyCommuteDisruption\":false,\"notifyFootballMatch\":false,\"notifyMorningBrief\":false,\"transitPassUntil\":\"\",\"parkingPassUntil\":\"\",\"notifyTicketExpiry\":false,\"watchedLineId\":\"TST:Line:42\",\"watchedLineCode\":\"42\",\"watchedStopAId\":\"NSR:StopPlace:90001\",\"watchedStopAName\":\"Alpha\",\"watchedStopBId\":\"NSR:StopPlace:90002\",\"watchedStopBName\":\"Beta\"}', revision = 1, updated_at = '2026-01-01T00:00:00.000Z', updated_by = NULL WHERE id = 1",
  );
});

const BUS_CONFIG_KEY = "TST:Line:42|NSR:StopPlace:90001|NSR:StopPlace:90002";

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
  return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } };
}

interface DashboardBody {
  schemaVersion: number;
  generatedAt: string;
  settingsRevision: number;
  window: string;
  sources: Record<
    string,
    { state: string; fetchedAt: string | null; observedAt: string | null; error: unknown; data: unknown }
  >;
}

describe("GET /v1/dashboard", () => {
  it("未认证 → 401", async () => {
    const res = await SELF.fetch("https://bff.example/v1/dashboard");
    expect(res.status).toBe(401);
  });

  it("没有任何快照时，六个来源都是 not_configured，且通过 DashboardSchema 自检", async () => {
    const owner = await claimOwner();

    const res = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));

    expect(res.status).toBe(200);
    const body = await res.json<DashboardBody>();
    expect(body.schemaVersion).toBe(1);
    expect(body.settingsRevision).toBe(1);
    expect(Object.keys(body.sources).sort()).toEqual(
      ["bus", "football", "train", "trafficOutbound", "trafficReturn", "weather"].sort(),
    );
    for (const key of Object.keys(body.sources)) {
      expect(body.sources[key]!.state).toBe("not_configured");
      expect(body.sources[key]!.data).toBeNull();
    }
  });

  it("没有写过 train 快照时为 not_configured", async () => {
    const owner = await claimOwner();

    const res = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));

    const body = await res.json<DashboardBody>();
    expect(body.sources.train!.state).toBe("not_configured");
  });

  it("train 快照用 trainConfigKey 回显；车站变为未选择/换站名后旧快照不可见", async () => {
    const owner = await claimOwner();
    const now = new Date("2026-09-22T06:00:00.000Z");
    await snapshot.putSuccess(
      env,
      "train",
      {
        work: { planText: "", legs: [], adviceLevel: "UNKNOWN", adviceText: "", alternatives: [], oppositeText: "", oppositeState: "NONE" },
        home: { planText: "", legs: [], adviceLevel: "UNKNOWN", adviceText: "", alternatives: [], oppositeText: "", oppositeState: "NONE" },
        transfer: null,
        updatedAt: "2026-09-22T08:00:00+02:00",
        originStation: "Spikkestad",
        destinationStation: "Sandvika",
      },
      { observedAt: now.toISOString(), configKey: "Spikkestad|Sandvika" },
      now,
    );

    const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
    const firstBody = await first.json<DashboardBody>();
    expect(firstBody.sources.train!.state).toBe("ok");

    // [gate] P9：换一个不在 L1 站表里的站名——不再回退默认站，configKey 变为 null，
    // 车站视为「未选择」，dashboard 立即变为 not_configured（旧快照不可见）。
    const before = await getSettingsRecord(env);
    const invalid = await putSettings(env, before.revision, { ...before.settings, originStation: "不存在的站" }, "device-1");
    if (!invalid.ok) throw new Error("putSettings 失败");
    const afterInvalid = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
    const afterInvalidBody = await afterInvalid.json<DashboardBody>();
    expect(afterInvalidBody.sources.train!.state).toBe("not_configured");
    expect(afterInvalidBody.sources.train!.data).toBeNull();

    // 换成另一个有效但不同的站名：configKey 变化，同样看不到旧快照。
    const afterFallback = await getSettingsRecord(env);
    const changed = await putSettings(env, afterFallback.revision, { ...afterFallback.settings, originStation: "Asker" }, "device-1");
    if (!changed.ok) throw new Error("putSettings 失败");
    const second = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
    const secondBody = await second.json<DashboardBody>();
    expect(secondBody.sources.train!.state).toBe("not_configured");
    expect(secondBody.sources.train!.data).toBeNull();
  });

  it("bus 快照存在时，回显对应的信封与数据", async () => {
    const owner = await claimOwner();
    const now = new Date("2026-09-22T06:00:00.000Z");
    await snapshot.putSuccess(
      env,
      "bus",
      { boards: [{ boardStop: "Alpha", towardStop: "Beta", departures: [] }], updatedAt: "2026-09-22T08:00:00+02:00" },
      { observedAt: now.toISOString(), configKey: BUS_CONFIG_KEY },
      now,
    );

    const res = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));

    const body = await res.json<DashboardBody>();
    expect(body.sources.bus!.state).toBe("ok");
    expect((body.sources.bus!.data as { boards: unknown[] }).boards).toHaveLength(1);
  });

  it("weather 快照的 configKey 与当前 originAddress 不一致时，视为 not_configured", async () => {
    const owner = await claimOwner();
    const now = new Date("2026-09-22T06:00:00.000Z");
    await snapshot.putSuccess(
      env,
      "weather",
      { temperature: 5, windSpeed: 1, precip1h: 0, symbolCode: "", tomorrowMorningTemp: null, tomorrowSymbol: "", updatedAt: "x", observedAt: "x", locationKey: "old address", daily: [] },
      { observedAt: now.toISOString(), configKey: "old address" },
      now,
    );
    const before = await getSettingsRecord(env);
    const result = await putSettings(env, before.revision, { ...before.settings, originAddress: "new address" }, "device-1");
    if (!result.ok) throw new Error("putSettings 失败");

    const res = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));

    const body = await res.json<DashboardBody>();
    expect(body.sources.weather!.state).toBe("not_configured");
    expect(body.sources.weather!.data).toBeNull();
  });

  it("ETag 一致时用 If-None-Match 返回 304", async () => {
    const owner = await claimOwner();
    // generatedAt 是响应体的一部分，会参与 ETag 计算；冻结时钟让两次请求的响应体逐字节
    // 相同，才能稳定复现「内容不变 → 304」，而不是偶然撞上同一毫秒。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T06:00:00.000Z"));
    try {
      const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();

      const second = await SELF.fetch(
        "https://bff.example/v1/dashboard",
        authed(owner.token, { headers: { "If-None-Match": etag! } }),
      );

      expect(second.status).toBe(304);
    } finally {
      vi.useRealTimers();
    }
  });

  // F3：CONTRACT 第 3 节规定 ETag 是「DashboardSchema.parse 之后、去掉 generatedAt 的
  // 对象」的哈希——generatedAt 本身逐次请求都不同（每次都是 now.toISOString()），
  // 不该参与 ETag 计算，否则 ETag 永远不会重复命中（除非像上面那样人为冻结时钟）。
  describe("F3：ETag 不受 generatedAt 影响", () => {
    it("不冻结时钟、快照不变时，两次请求第二次应命中 304", async () => {
      const owner = await claimOwner();

      const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();

      const second = await SELF.fetch(
        "https://bff.example/v1/dashboard",
        authed(owner.token, { headers: { "If-None-Match": etag! } }),
      );

      expect(second.status).toBe(304);
      expect(second.headers.get("ETag")).toBe(etag);
    });

    it("相隔 1 秒、同一窗口内，快照不变仍应 304", async () => {
      const owner = await claimOwner();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-22T06:00:00.000Z"));
      try {
        const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
        const etag = first.headers.get("ETag");

        vi.setSystemTime(new Date("2026-09-22T06:00:01.000Z"));
        const second = await SELF.fetch(
          "https://bff.example/v1/dashboard",
          authed(owner.token, { headers: { "If-None-Match": etag! } }),
        );

        expect(second.status).toBe(304);
      } finally {
        vi.useRealTimers();
      }
    });

    it("中间写入新的 bus 快照后，ETag 变化且返回 200", async () => {
      const owner = await claimOwner();
      const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
      const etag = first.headers.get("ETag");

      const now = new Date("2026-09-22T06:05:00.000Z");
      await snapshot.putSuccess(
        env,
        "bus",
        { boards: [], updatedAt: "2026-09-22T08:05:00+02:00" },
        { observedAt: now.toISOString(), configKey: BUS_CONFIG_KEY },
        now,
      );

      const second = await SELF.fetch(
        "https://bff.example/v1/dashboard",
        authed(owner.token, { headers: { "If-None-Match": etag! } }),
      );

      expect(second.status).toBe(200);
      expect(second.headers.get("ETag")).not.toBe(etag);
    });

    it("If-None-Match 支持 W/ 弱前缀与逗号分隔的多值列表", async () => {
      const owner = await claimOwner();
      const first = await SELF.fetch("https://bff.example/v1/dashboard", authed(owner.token));
      const etag = first.headers.get("ETag")!;

      const weak = await SELF.fetch(
        "https://bff.example/v1/dashboard",
        authed(owner.token, { headers: { "If-None-Match": `W/${etag}` } }),
      );
      expect(weak.status).toBe(304);

      const multi = await SELF.fetch(
        "https://bff.example/v1/dashboard",
        authed(owner.token, { headers: { "If-None-Match": `"x", ${etag}` } }),
      );
      expect(multi.status).toBe(304);
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
