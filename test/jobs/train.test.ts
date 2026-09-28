// train 任务的集成测试（fetchMock + fixture，D1 是真的）。领域逻辑本身已由
// test/golden/train.test.ts 逐条对照 Kotlin 覆盖，这里只测 I/O 层：请求构造
// （startTime、请求预算）、快照写入（成功/失败）、configKey 换站名后旧快照不可见。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import trainDeparturesOutside from "../fixtures/entur/train-departures-outside.json";
import trainEmptyDepartures from "../fixtures/entur/train-empty-departures.json";
import trainEmptyTrip from "../fixtures/entur/train-empty-trip.json";
import { trainJob } from "../../src/jobs/train";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import { get as getSnapshot } from "../../src/snapshot/store";
import { trainConfigKey } from "../../src/domain/l1-stations";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // [gate] P9：车站默认值改为空串，本文件所有用例都依赖有一对已选择的车站——
  // 这里显式设置一次（车站名与 test/golden/train.test.ts 保持一致，避开 P9 通用约定
  // 禁用的旧卡片站名）。
  const before = await getSettingsRecord(env);
  const result = await putSettings(
    env,
    before.revision,
    { ...before.settings, originStation: "Spikkestad", destStation: "Sandvika" },
    "test-setup",
  );
  if (!result.ok) throw new Error("测试初始化失败：无法设置车站");
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface RecordedCall {
  url: string;
  variables: Record<string, unknown>;
}

/** 按请求体里的变量形状分发响应：fetchBoth 用两个 stop_ 变量，fetchStop 只有一个，
 * fastestTrip 没有 stop_ 变量（用 from/to/at）。 */
function mockFetchRouter(responses: { fetchBoth: unknown; fastestTrip: unknown; fetchStop: unknown }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const requestInit = init as RequestInit;
    const body = JSON.parse(requestInit.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push({ url: String(url), variables: body.variables });
    const stopKeys = Object.keys(body.variables).filter((k) => k.startsWith("stop_"));
    let responseBody: unknown;
    if (stopKeys.length >= 2) {
      responseBody = responses.fetchBoth;
    } else if (stopKeys.length === 1) {
      responseBody = responses.fetchStop;
    } else {
      responseBody = responses.fastestTrip;
    }
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  return calls;
}

describe("trainJob：成功路径", () => {
  it("OUTSIDE 窗口：只发一次请求，写入快照，dashboard 视角为 ok", async () => {
    const calls = mockFetchRouter({
      fetchBoth: trainDeparturesOutside,
      fastestTrip: trainEmptyTrip,
      fetchStop: trainEmptyDepartures,
    });
    const now = new Date("2026-09-23T10:00:00.000Z"); // Oslo 12:00，WORK/RETURN 窗口外

    await trainJob(env, now, new AbortController().signal);

    expect(calls).toHaveLength(1);
    const snap = await getSnapshot(env, "train", "Spikkestad|Sandvika");
    expect(snap?.state).toBe("ok");
    const status = snap?.data as { work: { legs: unknown[] }; originStation: string; destinationStation: string };
    expect(status.originStation).toBe("Spikkestad");
    expect(status.destinationStation).toBe("Sandvika");
    expect(status.work.legs).toHaveLength(1);
  });

  it("startTime 为 now − 45 分钟", async () => {
    const calls = mockFetchRouter({
      fetchBoth: trainDeparturesOutside,
      fastestTrip: trainEmptyTrip,
      fetchStop: trainEmptyDepartures,
    });
    const now = new Date("2026-09-23T10:00:00.000Z");

    await trainJob(env, now, new AbortController().signal);

    const expectedStart = new Date(now.getTime() - 45 * 60_000).toISOString();
    expect(calls[0]!.variables.start_stopA).toBe(expectedStart);
    expect(calls[0]!.variables.start_stopB).toBe(expectedStart);
  });

  it("WORK 窗口：请求数不超过 3（fetchBoth + fastestTrip + fetchStop）", async () => {
    const calls = mockFetchRouter({
      fetchBoth: trainEmptyDepartures,
      fastestTrip: trainEmptyTrip,
      fetchStop: trainEmptyDepartures,
    });
    const now = new Date("2026-09-23T06:00:00.000Z"); // Oslo 08:00，WORK 窗口内

    await trainJob(env, now, new AbortController().signal);

    expect(calls.length).toBeLessThanOrEqual(3);
    const snap = await getSnapshot(env, "train", "Spikkestad|Sandvika");
    expect(snap?.state).toBe("ok");
  });

  // T4.6 item 4：RETURN 窗口 work/home 都调用 fastestTrip（方向相反），窗口外 transfer 恒为
  // null（不发 fetchStop），因此总请求数同样 ≤3（fetchBoth + fastestTrip×2）。
  it("RETURN 窗口：请求数不超过 3，且两次 fastestTrip 方向相反", async () => {
    const calls = mockFetchRouter({
      fetchBoth: trainEmptyDepartures,
      fastestTrip: trainEmptyTrip,
      fetchStop: trainEmptyDepartures,
    });
    const now = new Date("2026-09-23T13:00:00.000Z"); // Oslo 15:00，RETURN 窗口内

    await trainJob(env, now, new AbortController().signal);

    expect(calls.length).toBeLessThanOrEqual(3);
    const fastestTripCalls = calls.filter(
      (c) => !Object.keys(c.variables).some((k) => k.startsWith("stop_")),
    );
    expect(fastestTripCalls).toHaveLength(2);
    expect(fastestTripCalls[0]!.variables.from).toBe("NSR:StopPlace:60736");
    expect(fastestTripCalls[0]!.variables.to).toBe("NSR:StopPlace:610");
    expect(fastestTripCalls[1]!.variables.from).toBe("NSR:StopPlace:610");
    expect(fastestTripCalls[1]!.variables.to).toBe("NSR:StopPlace:60736");
    const snap = await getSnapshot(env, "train", "Spikkestad|Sandvika");
    expect(snap?.state).toBe("ok");
  });
});

// T4.6 item 4：调度取消（signal 被外部中止）不能被 fastestTrip/fetchStop 的 try/catch
// 悄悄吞掉（同 T3.7 F2 traffic 的做法）——中止应该让 trainJob 整体失败并归为
// upstream_timeout，而不是写出一份看似正常的 ok 快照。
describe("trainJob：调度取消", () => {
  it("fetch 内部触发 abort 后抛错：WORK 窗口写入 putFailure(upstream_timeout) 而非 ok 快照", async () => {
    const controller = new AbortController();
    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const requestInit = init as RequestInit;
      const body = JSON.parse(requestInit.body as string) as { variables: Record<string, unknown> };
      const stopKeys = Object.keys(body.variables).filter((k) => k.startsWith("stop_"));
      fetchCallCount += 1;
      if (stopKeys.length === 1) {
        // 换乘面板的 fetchStop 请求：模拟「请求进行中被外部取消」——fetch 自己检测到
        // 传入的 signal 被中止，拒绝返回；同时真的把 controller 中止掉，让
        // domain/train.ts 里 `signal?.aborted` 的判断为 true，从而不把这次失败悄悄吞掉。
        controller.abort();
        return Promise.reject(new Error("The operation was aborted"));
      }
      if (stopKeys.length >= 2) {
        return Promise.resolve(
          new Response(JSON.stringify(trainEmptyDepartures), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(trainEmptyTrip), { status: 200, headers: { "content-type": "application/json" } }),
      );
    });
    const now = new Date("2026-09-23T06:00:00.000Z"); // Oslo 08:00，WORK 窗口内（触发换乘面板）

    await trainJob(env, now, controller.signal);

    // fetchBoth（1）+ fastestTrip（1，成功）+ fetchStop（1，触发 abort）= 3。
    expect(fetchCallCount).toBe(3);
    const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = 'train'").first<{
      state: string | null;
      error_json: string | null;
    }>();
    expect(row?.state).toBe("stale");
    const error = row?.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
    expect(error?.code).toBe("upstream_timeout");
  });
});

describe("trainJob：失败路径", () => {
  it("fetchBoth 503 → putFailure(upstream_5xx)，保留旧快照", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 503 }));
    const now = new Date("2026-09-23T10:00:00.000Z");

    await trainJob(env, now, new AbortController().signal);

    const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = 'train'").first<{
      state: string | null;
      error_json: string | null;
    }>();
    expect(row?.state).toBe("stale");
    const error = row?.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
    expect(error?.code).toBe("upstream_5xx");
  });
});

describe("trainJob：configKey", () => {
  it("换站名后旧快照不可见", async () => {
    mockFetchRouter({
      fetchBoth: trainDeparturesOutside,
      fastestTrip: trainEmptyTrip,
      fetchStop: trainEmptyDepartures,
    });
    const now = new Date("2026-09-23T10:00:00.000Z");

    await trainJob(env, now, new AbortController().signal);
    expect((await getSnapshot(env, "train", "Spikkestad|Sandvika"))?.state).toBe("ok");

    const before = await getSettingsRecord(env);
    const changed = await putSettings(env, before.revision, { ...before.settings, originStation: "Asker" }, "device-1");
    if (!changed.ok) throw new Error("putSettings 失败");
    const newSettings = (await getSettingsRecord(env)).settings;

    expect(trainConfigKey(newSettings)).toBe("Asker|Sandvika");
    expect(await getSnapshot(env, "train", trainConfigKey(newSettings))).toBeNull();
  });
});

// [gate] P9：车站未选择（含空串）或站名无效时不再回退默认站，直接写 not_configured，
// 不发任何请求。放在文件最后，避免影响前面依赖已选择车站的用例。
describe("trainJob：车站未选择", () => {
  it("空站名 → not_configured，0 次请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await getSettingsRecord(env);
    const cleared = await putSettings(env, before.revision, { ...before.settings, originStation: "", destStation: "" }, "device-1");
    if (!cleared.ok) throw new Error("putSettings 失败");
    const now = new Date("2026-09-23T10:00:00.000Z");

    await trainJob(env, now, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT state, config_key, json FROM snapshots WHERE source = 'train'").first<{
      state: string | null;
      config_key: string | null;
      json: string | null;
    }>();
    expect(row?.state).toBe("not_configured");
    expect(row?.config_key).toBeNull();
    expect(row?.json).toBeNull();
  });

  it("无效站名（不在 L1 站表里）→ not_configured，0 次请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await getSettingsRecord(env);
    const invalid = await putSettings(
      env,
      before.revision,
      { ...before.settings, originStation: "不存在的站", destStation: "也不存在" },
      "device-1",
    );
    if (!invalid.ok) throw new Error("putSettings 失败");
    const now = new Date("2026-09-23T10:00:00.000Z");

    await trainJob(env, now, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const snap = await getSnapshot(env, "train", null);
    expect(snap?.state).toBe("not_configured");
  });
});
