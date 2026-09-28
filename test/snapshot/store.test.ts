import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { get, getMany, getValidators, putFailure, putNotModified, putState, putSuccess } from "../../src/snapshot/store";
import { instrumentD1 } from "../helpers/d1-counter";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("快照存储", () => {
  it("成功写入后可以读到 data / state=ok", async () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    await putSuccess(
      env,
      "weather",
      { temperature: 5 },
      { observedAt: "2026-01-01T09:59:00.000Z", configKey: "loc-1" },
      now,
    );
    const snap = await get(env, "weather", "loc-1");
    expect(snap).toEqual({
      state: "ok",
      fetchedAt: "2026-01-01T10:00:00.000Z",
      observedAt: "2026-01-01T09:59:00.000Z",
      error: null,
      data: { temperature: 5 },
    });
  });

  it("失败时 configKey 相同则保留旧数据，只把 state 置为 stale 并写入 error", async () => {
    const t1 = new Date("2026-01-01T10:00:00.000Z");
    await putSuccess(env, "train", { line: "L1" }, { observedAt: null, configKey: "a|b" }, t1);

    const t2 = new Date("2026-01-01T10:05:00.000Z");
    await putFailure(env, "train", { code: "upstream_timeout", message: "超时", at: t2.toISOString() }, "a|b", t2);

    const snap = await get(env, "train", "a|b");
    expect(snap).not.toBeNull();
    expect(snap?.state).toBe("stale");
    // 旧数据与 fetchedAt 保留，没有被失败覆盖
    expect(snap?.data).toEqual({ line: "L1" });
    expect(snap?.fetchedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(snap?.error).toEqual({ code: "upstream_timeout", message: "超时", at: t2.toISOString() });
  });

  // F4：configKey 变了（例如换了地址）说明旧数据不再适用，putFailure 必须整行重写
  // （清空 json/etag/last_modified/fetched_at/observed_at），不能把旧地址的数据继续
  // 挂在新 configKey 名下——否则 dashboard 会把「查无数据」误显示成「有数据但是 stale」。
  it("失败时 configKey 变化则整行重写：旧数据不再可见", async () => {
    const t1 = new Date("2026-01-01T10:00:00.000Z");
    await putSuccess(env, "train3", { line: "old" }, { observedAt: "2026-01-01T09:59:00.000Z", configKey: "a|b", etag: "W/e1", lastModified: "Mon" }, t1);

    const t2 = new Date("2026-01-01T10:05:00.000Z");
    await putFailure(env, "train3", { code: "upstream_5xx", message: "500", at: t2.toISOString() }, "c|d", t2);

    // 旧 configKey 已经读不到（get() 本身就会因 configKey 不匹配返回 null）。
    expect(await get(env, "train3", "a|b")).toBeNull();

    const snap = await get(env, "train3", "c|d");
    expect(snap).toEqual({
      state: "stale",
      fetchedAt: null,
      observedAt: null,
      error: { code: "upstream_5xx", message: "500", at: t2.toISOString() },
      data: null,
    });
  });

  it("从未成功过时失败也能插入一行（data 为 null）", async () => {
    const now = new Date("2026-01-01T11:00:00.000Z");
    await putFailure(env, "bus", { code: "upstream_5xx", message: "500", at: now.toISOString() }, null, now);
    const snap = await get(env, "bus", null);
    expect(snap).toEqual({
      state: "stale",
      fetchedAt: null,
      observedAt: null,
      error: { code: "upstream_5xx", message: "500", at: now.toISOString() },
      data: null,
    });
  });

  // F4：bus 首次刷新就 503——对应 dashboard 里 bus 信封应显示 stale/upstream_5xx/data null。
  it("bus 首次 503 → stale、upstream_5xx、data null（对应 dashboard bus 信封）", async () => {
    const now = new Date("2026-01-01T11:30:00.000Z");
    await putFailure(env, "bus2", { code: "upstream_5xx", message: "HTTP 503", at: now.toISOString() }, "42", now);
    const snap = await get(env, "bus2", "42");
    expect(snap?.state).toBe("stale");
    expect(snap?.error?.code).toBe("upstream_5xx");
    expect(snap?.data).toBeNull();
  });

  it("304 只动 fetched_at，不动 json / observedAt / etag", async () => {
    const t1 = new Date("2026-01-01T12:00:00.000Z");
    await putSuccess(
      env,
      "traffic_outbound",
      { durationSec: 100 },
      { observedAt: "2026-01-01T11:58:00.000Z", etag: "W/abc", configKey: null },
      t1,
    );

    const t2 = new Date("2026-01-01T12:05:00.000Z");
    await putNotModified(env, "traffic_outbound", t2);

    const snap = await get(env, "traffic_outbound", null);
    expect(snap?.state).toBe("ok");
    expect(snap?.fetchedAt).toBe("2026-01-01T12:05:00.000Z");
    expect(snap?.observedAt).toBe("2026-01-01T11:58:00.000Z");
    expect(snap?.data).toEqual({ durationSec: 100 });
  });

  it("configKey 变化后读不到旧快照", async () => {
    const now = new Date("2026-01-01T13:00:00.000Z");
    await putSuccess(env, "train2", { line: "L2" }, { observedAt: null, configKey: "Spikkestad|Nationaltheatret" }, now);

    expect(await get(env, "train2", "Spikkestad|Nationaltheatret")).not.toBeNull();
    expect(await get(env, "train2", "OtherStation|Nationaltheatret")).toBeNull();
  });

  it("不存在的 source 返回 null", async () => {
    expect(await get(env, "no_such_source", null)).toBeNull();
  });

  it("putState 写 idle（configKey 相同）时保留已有数据", async () => {
    const t1 = new Date("2026-01-01T14:00:00.000Z");
    await putSuccess(env, "football", { updatedAt: "x" }, { observedAt: null, configKey: "86" }, t1);

    const t2 = new Date("2026-01-01T14:10:00.000Z");
    await putState(env, "football", "idle", "86", t2);
    const snap = await get(env, "football", "86");
    expect(snap?.state).toBe("idle");
    expect(snap?.data).toEqual({ updatedAt: "x" });
  });

  it("putState 写 not_configured（从未存在过的行）", async () => {
    const t2 = new Date("2026-01-01T14:10:00.000Z");
    await putState(env, "traffic_return_new", "not_configured", null, t2);
    const snap2 = await get(env, "traffic_return_new", null);
    expect(snap2).toEqual({
      state: "not_configured",
      fetchedAt: null,
      observedAt: null,
      error: null,
      data: null,
    });
  });

  // F4：地址已填（configKey 非空）但首次刷新就落在窗口外——traffic_outbound 应该是
  // idle，而不是 not_configured（有配置，只是按日程不刷新）。
  it("地址已填、首次在窗口外 → putState(idle, configKey) 直接建行，data 为 null", async () => {
    const now = new Date("2026-01-01T15:00:00.000Z");
    await putState(env, "traffic_outbound_window", "idle", "Asker|Oslo S", now);
    const snap = await get(env, "traffic_outbound_window", "Asker|Oslo S");
    expect(snap).toEqual({
      state: "idle",
      fetchedAt: null,
      observedAt: null,
      error: null,
      data: null,
    });
  });

  // F4：putState("not_configured") 一律清空 json/etag/last_modified，哪怕 configKey
  // 没变——「未配置」意味着旧数据已经不该再被当作「有效但陈旧」的数据展示。
  it("putState(not_configured) 即使 configKey 相同，也清空 json/etag/last_modified", async () => {
    const t1 = new Date("2026-01-01T16:00:00.000Z");
    await putSuccess(
      env,
      "weather3",
      { temperature: 1 },
      { observedAt: "2026-01-01T15:59:00.000Z", etag: "W/e", lastModified: "Mon", configKey: "addr-a" },
      t1,
    );

    const t2 = new Date("2026-01-01T16:05:00.000Z");
    await putState(env, "weather3", "not_configured", "addr-a", t2);

    const snap = await get(env, "weather3", "addr-a");
    expect(snap).toEqual({
      state: "not_configured",
      fetchedAt: null,
      observedAt: null,
      error: null,
      data: null,
    });
  });

  // F4：configKey 变化时 putState 也要整行重写（不只是 putFailure）。
  it("putState configKey 变化时整行重写，旧数据不可见", async () => {
    const t1 = new Date("2026-01-01T17:00:00.000Z");
    await putSuccess(env, "weather4", { temperature: 9 }, { observedAt: null, configKey: "addr-old" }, t1);

    const t2 = new Date("2026-01-01T17:05:00.000Z");
    await putState(env, "weather4", "idle", "addr-new", t2);

    expect(await get(env, "weather4", "addr-old")).toBeNull();
    const snap = await get(env, "weather4", "addr-new");
    expect(snap).toEqual({
      state: "idle",
      fetchedAt: null,
      observedAt: null,
      error: null,
      data: null,
    });
  });

  // F4：putNotModified 应该清空 error_json——上一次若是失败后又收到 304，代表「（新的
  // 一轮里）没有变化」，不该继续展示上一次失败的错误信息。
  // F6：getValidators 是 weather.ts 应该用来取 If-Modified-Since 校验值的入口
  // （不再直接查 snapshots 表）。
  describe("getValidators", () => {
    it("成功写入后能取到 etag/lastModified", async () => {
      const now = new Date("2026-01-01T19:00:00.000Z");
      await putSuccess(env, "weather6", { t: 1 }, { observedAt: null, etag: '"e1"', lastModified: "Mon", configKey: "addr-6" }, now);
      expect(await getValidators(env, "weather6", "addr-6")).toEqual({ etag: '"e1"', lastModified: "Mon" });
    });

    it("configKey 不匹配 → null", async () => {
      const now = new Date("2026-01-01T19:05:00.000Z");
      await putSuccess(env, "weather7", { t: 1 }, { observedAt: null, etag: '"e2"', lastModified: "Tue", configKey: "addr-old" }, now);
      expect(await getValidators(env, "weather7", "addr-new")).toBeNull();
    });

    it("putFailure 后（configKey 相同）仍可取到旧的校验值", async () => {
      const t1 = new Date("2026-01-01T19:10:00.000Z");
      await putSuccess(env, "weather8", { t: 1 }, { observedAt: null, etag: '"e3"', lastModified: "Wed", configKey: "addr-8" }, t1);
      const t2 = new Date("2026-01-01T19:15:00.000Z");
      await putFailure(env, "weather8", { code: "upstream_timeout", message: "超时", at: t2.toISOString() }, "addr-8", t2);
      expect(await getValidators(env, "weather8", "addr-8")).toEqual({ etag: '"e3"', lastModified: "Wed" });
    });

    it("not_configured 之后 → null（json 已被清空）", async () => {
      const t1 = new Date("2026-01-01T19:20:00.000Z");
      await putSuccess(env, "weather9", { t: 1 }, { observedAt: null, etag: '"e4"', lastModified: "Thu", configKey: "addr-9" }, t1);
      const t2 = new Date("2026-01-01T19:25:00.000Z");
      await putState(env, "weather9", "not_configured", "addr-9", t2);
      expect(await getValidators(env, "weather9", "addr-9")).toBeNull();
    });

    it("没有行时返回 null", async () => {
      expect(await getValidators(env, "no-such-weather-row", null)).toBeNull();
    });
  });

  it("putNotModified 清空 error_json", async () => {
    const t1 = new Date("2026-01-01T18:00:00.000Z");
    await putSuccess(env, "weather5", { temperature: 2 }, { observedAt: null, configKey: "addr-5" }, t1);
    const t2 = new Date("2026-01-01T18:05:00.000Z");
    await putFailure(env, "weather5", { code: "upstream_timeout", message: "超时", at: t2.toISOString() }, "addr-5", t2);

    const t3 = new Date("2026-01-01T18:10:00.000Z");
    await putNotModified(env, "weather5", t3);

    const snap = await get(env, "weather5", "addr-5");
    expect(snap?.state).toBe("ok");
    expect(snap?.error).toBeNull();
  });

  // T5.3：getMany 一次查询覆盖多个来源，判断规则与 get() 一致。
  describe("getMany", () => {
    it("一条 SELECT 查询覆盖多个来源", async () => {
      const now = new Date("2026-02-01T10:00:00.000Z");
      await putSuccess(env, "gm_weather", { t: 1 }, { observedAt: null, configKey: "addr-gm" }, now);
      await putSuccess(env, "gm_train", { line: "L1" }, { observedAt: null, configKey: "A|B" }, now);

      const instrumented = instrumentD1(env.DB);
      const testEnv = { ...env, DB: instrumented.db };
      const result = await getMany(testEnv, [
        { source: "gm_weather", configKey: "addr-gm" },
        { source: "gm_train", configKey: "A|B" },
      ]);

      expect(instrumented.count()).toBe(1);
      expect(result.gm_weather).toEqual({
        state: "ok",
        fetchedAt: now.toISOString(),
        observedAt: null,
        error: null,
        data: { t: 1 },
      });
      expect(result.gm_train?.data).toEqual({ line: "L1" });
    });

    it("configKey 不匹配为 null", async () => {
      const now = new Date("2026-02-01T10:05:00.000Z");
      await putSuccess(env, "gm_weather2", { t: 2 }, { observedAt: null, configKey: "addr-old" }, now);
      const result = await getMany(env, [{ source: "gm_weather2", configKey: "addr-new" }]);
      expect(result.gm_weather2).toBeNull();
    });

    it("不存在的来源为 null", async () => {
      const result = await getMany(env, [{ source: "no_such_gm_source", configKey: null }]);
      expect(result.no_such_gm_source).toBeNull();
    });

    it("空数组不发查询", async () => {
      const instrumented = instrumentD1(env.DB);
      const testEnv = { ...env, DB: instrumented.db };
      const result = await getMany(testEnv, []);
      expect(result).toEqual({});
      expect(instrumented.count()).toBe(0);
    });
  });
});
