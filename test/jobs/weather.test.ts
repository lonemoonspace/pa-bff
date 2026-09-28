// 两部分：
// 1) pickPoint —— 对应 app/.../data/weather/WeatherPointPickerTest.kt 的每个用例；
// 2) weatherJob —— 对应 app/.../data/weather/WeatherRepositoryTest.kt 里与天气相关的用例
//    （路况共享地理编码缓存那条属于 T3.4 traffic 的范围，这里不重复）。
// D1 是真的（vitest-pool-workers，isolatedStorage 默认按 test 隔离），geocoder / MET
// 走 vi.spyOn(globalThis, "fetch")，不访问真实网络；geocodeAddress 的缓存是模块级单例，
// 跨 test 不会重置，因此需要缓存复用的地址用随机后缀区分测试。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { get as getSnapshot } from "../../src/snapshot/store";
import { putSettings, getSettingsRecord } from "../../src/config/store";
import { pickPoint, weatherJob } from "../../src/jobs/weather";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// pickPoint（WeatherPointPickerTest.kt）
// ---------------------------------------------------------------------

describe("pickPoint", () => {
  const now = new Date("2026-09-22T06:00:00.000Z"); // 对应 Kotlin 用例里 Oslo 08:00

  const at = (hoursFromNow: number, minutes = 0): Date =>
    new Date(now.getTime() + hoursFromNow * 3_600_000 + minutes * 60_000);

  const pick = (times: (Date | null)[]): Date | null => pickPoint(times, now, (t) => t);

  it("prefers the point inside the window before now", () => {
    const times = [at(-2), at(-1), at(0, -30), at(1)];
    expect(pick(times)).toEqual(at(0, -30));
  });

  it("accepts an upcoming point inside the 90 minute window", () => {
    const times = [at(-3), at(0, 80), at(2)];
    expect(pick(times)).toEqual(at(0, 80));
  });

  it("picks the nearest point when the window misses", () => {
    const times = [at(-6), at(4)];
    expect(pick(times)).toEqual(at(4));
  });

  it("picks the earlier point when the two candidates are equally far away", () => {
    const times = [at(-2), at(2)];
    expect(pick(times)).toEqual(at(-2));
  });

  it("falls back to the first item when no time can be parsed", () => {
    const items = ["first", "second"];
    expect(pickPoint(items, now, () => null)).toBe("first");
  });

  it("skips unparseable times when some other points have one", () => {
    const items = ["no-time", "timed"];
    const result = pickPoint(items, now, (item) => (item === "timed" ? at(0, 10) : null));
    expect(result).toBe("timed");
  });

  it("returns null for an empty series", () => {
    expect(pickPoint<string>([], now, () => null)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// weatherJob（WeatherRepositoryTest.kt 的天气相关用例）
// ---------------------------------------------------------------------

async function setOriginAddress(address: string): Promise<void> {
  const before = await getSettingsRecord(env);
  const result = await putSettings(env, before.revision, { ...before.settings, originAddress: address }, "device-1");
  if (!result.ok) throw new Error("putSettings 失败");
}

function metBody(...points: Array<{ time: string; temp: number }>): unknown {
  return {
    properties: {
      timeseries: points.map(({ time, temp }) => ({
        time,
        data: {
          instant: { details: { air_temperature: temp, wind_speed: 1.2 } },
          next_1_hours: { summary: { symbol_code: "clearsky_day" }, details: { precipitation_amount: 0.0 } },
        },
      })),
    },
  };
}

/** 按 url 分流：geocoder 走 geoBody，locationforecast 走 metBodyValue。 */
function mockFetch(geoBody: unknown, metBodyValue: unknown, metHeaders: Record<string, string> = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    const u = String(url);
    if (u.includes("geocoder")) {
      return Promise.resolve(new Response(JSON.stringify(geoBody), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(metBodyValue), { status: 200, headers: { "content-type": "application/json", ...metHeaders } }),
    );
  });
}

function geoHit(lat = 59.8331, lon = 10.4356): unknown {
  return { features: [{ geometry: { coordinates: [lon, lat] } }] };
}

/**
 * 绕过 get() 的 configKey 匹配直接读原始行：这个测试文件里多个用例共享同一份 D1
 * 存储（isolatedStorage 是按文件级别隔离，不是按用例），putState/putFailure 都不写
 * configKey，会保留前一条成功快照留下的旧值，用 get(env,"weather",配置好的地址) 去读
 * 会因为 configKey 对不上而拿到 null——这里只关心 state/error，直接查行更稳妥。
 */
async function rawWeatherRow(): Promise<{ state: string | null; errorCode: string | null } | null> {
  const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = 'weather'").first<{
    state: string | null;
    error_json: string | null;
  }>();
  if (!row) return null;
  const error = row.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
  return { state: row.state, errorCode: error?.code ?? null };
}

describe("weatherJob", () => {
  it("originAddress 为空时 → not_configured，不发请求", async () => {
    await setOriginAddress("");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await weatherJob(env, new Date("2026-09-22T06:00:00.000Z"), new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawWeatherRow();
    expect(row?.state).toBe("not_configured");
  });

  it(
    "observedAt and the temperature come from the data point nearest to now when the window misses",
    async () => {
      const address = "Asker stasjon miss " + Math.random();
      await setOriginAddress(address);
      const now = new Date("2026-09-22T06:00:00.000Z");
      const stale = new Date(now.getTime() - 6 * 3_600_000);
      const ahead = new Date(now.getTime() + 4 * 3_600_000);
      mockFetch(geoHit(), metBody({ time: stale.toISOString(), temp: -3.0 }, { time: ahead.toISOString(), temp: -8.0 }));

      await weatherJob(env, now, new AbortController().signal);

      const snap = await getSnapshot(env, "weather", address.trim());
      expect(snap?.state).toBe("ok");
      const data = snap?.data as { temperature: number; observedAt: string; updatedAt: string };
      expect(data.temperature).toBe(-8.0);
      // observedAt（数据点时刻）必须晚于 updatedAt（刷新时刻）——数据点其实在未来，
      // 这正是「取最近点」而不是「取序列第一个点」要保留的信息。
      expect(new Date(data.observedAt).getTime()).toBeGreaterThan(new Date(data.updatedAt).getTime());
      expect(new Date(data.observedAt).getTime()).toBe(ahead.getTime());
    },
  );

  it("observedAt is the picked point inside the window and the refresh time is separate", async () => {
    const address = "Asker stasjon inwindow " + Math.random();
    await setOriginAddress(address);
    const now = new Date("2026-09-22T06:00:00.000Z");
    const inWindow = new Date(now.getTime() - 20 * 60_000);
    mockFetch(geoHit(), metBody({ time: inWindow.toISOString(), temp: 4.5 }));

    await weatherJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "weather", address.trim());
    const data = snap?.data as { temperature: number; observedAt: string };
    expect(data.temperature).toBe(4.5);
    expect(new Date(data.observedAt).getTime()).toBe(inWindow.getTime());
  });

  it("geocodes the origin only once across repeated weather refreshes", async () => {
    const address = "Asker stasjon repeat " + Math.random();
    await setOriginAddress(address);
    const now = new Date("2026-09-22T06:00:00.000Z");
    let geoCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) {
        geoCalls += 1;
        return Promise.resolve(new Response(JSON.stringify(geoHit()), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(metBody({ time: now.toISOString(), temp: 1.0 })), { status: 200 }),
      );
    });

    await weatherJob(env, now, new AbortController().signal);
    await weatherJob(env, now, new AbortController().signal);

    expect(geoCalls).toBe(1);
  });

  // F2：geocode 超时（无 HTTP 响应，SourceFailure 没有 status）不该被 geocodeAddress
  // 静默吞掉——之前 weatherJob 没把 geocodeAddress 包进 try，这类异常会直接从
  // weatherJob 里逃逸出去（未捕获），而不是像其它失败一样落进快照的 error。
  it("geocode 超时时快照 error.code = upstream_timeout（不是未捕获异常）", async () => {
    const address = "nowhere weather timeout " + Math.random();
    await setOriginAddress(address);
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = String(url);
      if (u.includes("geocoder")) {
        const signal = (init as RequestInit).signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject((signal as AbortSignal).reason));
        });
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    await weatherJob(env, new Date("2026-09-22T06:00:00.000Z"), AbortSignal.timeout(10));

    const row = await rawWeatherRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("upstream_timeout");
  });

  it("地址地理编码失败（geocodeAddress 返回 null）→ putFailure(upstream_4xx)，不请求 MET", async () => {
    const address = "nowhere weather job " + Math.random();
    await setOriginAddress(address);
    const metSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) return Promise.resolve(new Response("server error", { status: 500 }));
      metSpy();
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    await weatherJob(env, new Date("2026-09-22T06:00:00.000Z"), new AbortController().signal);

    expect(metSpy).not.toHaveBeenCalled();
    const row = await rawWeatherRow();
    expect(row?.state).toBe("stale");
    expect(row?.errorCode).toBe("upstream_4xx");
  });

  it("MET 返回 304 → putNotModified，返回的 CadenceCtx 带上 Expires", async () => {
    const address = "Asker stasjon 304 " + Math.random();
    await setOriginAddress(address);
    const now = new Date("2026-09-22T06:00:00.000Z");
    // 先成功写一次，产生带 configKey 的旧快照。
    mockFetch(geoHit(), metBody({ time: now.toISOString(), temp: 2.0 }));
    await weatherJob(env, now, new AbortController().signal);

    const expires = new Date(now.getTime() + 45 * 60_000);
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) return Promise.resolve(new Response(JSON.stringify(geoHit()), { status: 200 }));
      // 304 的 Response 规范上不允许带 body。
      return Promise.resolve(new Response(null, { status: 304, headers: { expires: expires.toUTCString() } }));
    });
    const later = new Date(now.getTime() + 30 * 60_000);
    const ctx = await weatherJob(env, later, new AbortController().signal);

    expect(ctx?.weatherExpiresAt?.getTime()).toBe(expires.getTime());
    const snap = await getSnapshot(env, "weather", address.trim());
    expect(snap?.state).toBe("ok");
    // 304 不改数据：温度仍是第一次成功写入的 2.0。
    expect((snap?.data as { temperature: number }).temperature).toBe(2.0);
  });
});

// ---------------------------------------------------------------------
// 逐日预报（DailyForecastBuilder.kt 移植，Kotlin 端没有独立测试文件，
// 这里按 BRIEF「新代码必须有测试」直接测输出）。
// ---------------------------------------------------------------------

describe("weatherJob 的逐日预报", () => {
  it("按 Oslo 日期分组，跳过没有气温数据的日子", async () => {
    const address = "Daily forecast " + Math.random();
    await setOriginAddress(address);
    const now = new Date("2026-09-22T06:00:00.000Z"); // Oslo 08:00
    mockFetch(
      geoHit(),
      metBody(
        { time: "2026-09-22T10:00:00Z", temp: 15 },
        { time: "2026-09-22T14:00:00Z", temp: 20 },
        { time: "2026-09-23T10:00:00Z", temp: 12 },
      ),
    );

    await weatherJob(env, now, new AbortController().signal);

    const snap = await getSnapshot(env, "weather", address.trim());
    const daily = (snap?.data as { daily: Array<{ date: string; minTemp: number; maxTemp: number }> }).daily;
    expect(daily[0]).toMatchObject({ date: "2026-09-22", minTemp: 15, maxTemp: 20 });
    expect(daily[1]).toMatchObject({ date: "2026-09-23", minTemp: 12, maxTemp: 12 });
  });
});
