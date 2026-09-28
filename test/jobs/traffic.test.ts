// 对应 app/.../data/traffic/TrafficRepositoryTest.kt 的可移植用例（窗口判定、密钥缺失/
// 不可解密、小数秒解析、等级阈值）+ 天气/路况共享地理编码缓存那一例（在 WeatherRepositoryTest.kt
// 里，按 T3.4 分工挪到这里）。D1 是真的（vitest-pool-workers），Google/Entur 走
// vi.spyOn(globalThis, "fetch")，不访问真实网络。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { get as getSnapshot } from "../../src/snapshot/store";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import { putSecret } from "../../src/secrets/store";
import { trafficOutboundJob, trafficReturnJob } from "../../src/jobs/traffic";
import { weatherJob } from "../../src/jobs/weather";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// WORK 窗口默认 07:00–10:00，RETURN 默认 14:00–16:00（Europe/Oslo）。
// 2026-09-22 是夏令时（UTC+2）：08:00 Oslo = 06:00Z（WORK），15:00 Oslo = 13:00Z（RETURN），
// 12:00 Oslo = 10:00Z（窗口外）。
const WORK_NOW = new Date("2026-09-22T06:00:00.000Z");
const RETURN_NOW = new Date("2026-09-22T13:00:00.000Z");
const OUTSIDE_NOW = new Date("2026-09-22T10:00:00.000Z");

async function setSettings(patch: Partial<{ originAddress: string; destinationAddress: string }>): Promise<void> {
  const before = await getSettingsRecord(env);
  const result = await putSettings(env, before.revision, { ...before.settings, ...patch }, "device-1");
  if (!result.ok) throw new Error("putSettings 失败");
}

function geoHit(lat = 59.8331, lon = 10.4356): unknown {
  return { features: [{ geometry: { coordinates: [lon, lat] } }] };
}

function routesOk(durationS: string, staticS: string, distanceMeters = 8000): unknown {
  return { routes: [{ duration: durationS, staticDuration: staticS, distanceMeters }] };
}

/** 按 url 分流：geocoder / routes 各走各的 mock 数据；未识别的 url 视为测试失误。 */
function mockFetch(opts: { geo?: unknown; geoStatus?: number; routes?: unknown; routesStatus?: number }): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    const u = String(url);
    if (u.includes("geocoder")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.geo ?? { features: [] }), { status: opts.geoStatus ?? 200 }),
      );
    }
    if (u.includes("routes.googleapis.com")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.routes ?? routesOk("600s", "500s")), { status: opts.routesStatus ?? 200 }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

async function rawTrafficRow(source: "traffic_outbound" | "traffic_return"): Promise<{
  state: string | null;
  errorCode: string | null;
} | null> {
  const row = await env.DB.prepare("SELECT state, error_json FROM snapshots WHERE source = ?")
    .bind(source)
    .first<{ state: string | null; error_json: string | null }>();
  if (!row) return null;
  const error = row.error_json ? (JSON.parse(row.error_json) as { code: string }) : null;
  return { state: row.state, errorCode: error?.code ?? null };
}

describe("trafficOutboundJob / trafficReturnJob：窗口判定", () => {
  it("outbound 不在 WORK 窗口时 → idle，不发请求", async () => {
    await setSettings({ originAddress: "Asker stasjon", destinationAddress: "Oslo S" });
    mockFetch({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await trafficOutboundJob(env, OUTSIDE_NOW, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawTrafficRow("traffic_outbound");
    expect(row?.state).toBe("idle");
  });

  it("return 不在 RETURN 窗口时 → idle，不发请求", async () => {
    await setSettings({ originAddress: "Asker stasjon", destinationAddress: "Oslo S" });
    mockFetch({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await trafficReturnJob(env, WORK_NOW, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawTrafficRow("traffic_return");
    expect(row?.state).toBe("idle");
  });
});

describe("trafficOutboundJob：设置/密钥缺失", () => {
  it("地址为空 → not_configured，不发请求", async () => {
    await setSettings({ originAddress: "", destinationAddress: "" });
    mockFetch({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawTrafficRow("traffic_outbound");
    expect(row?.state).toBe("not_configured");
  });

  it("缺 google_routes 密钥 → not_configured，不发请求", async () => {
    await env.DB.exec("DELETE FROM secrets WHERE name = 'google_routes'");
    await setSettings({ originAddress: "Asker stasjon key-missing", destinationAddress: "Oslo S" });
    mockFetch({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await rawTrafficRow("traffic_outbound");
    expect(row?.state).toBe("not_configured");
  });

  it(
    "regression：密文不可解密（AES-GCM 认证失败）时绝不把密文当 apiKey 发给 Google，仍是 not_configured",
    async () => {
      mockFetch({ geo: geoHit(), routes: routesOk("600s", "500s") });
      const put = await putSecret(env, "google_routes", "plain-real-key-123");
      expect(put.ok).toBe(true);
      // 直接写坏 ciphertext：AES-GCM 认证 tag 对不上，open() 按约定返回 null。
      await env.DB.prepare("UPDATE secrets SET ciphertext = ? WHERE name = 'google_routes'")
        .bind(btoa("this-is-not-the-real-ciphertext-bytes"))
        .run();

      await setSettings({ originAddress: "Asker stasjon undecryptable", destinationAddress: "Oslo S" });
      const routesSpy = vi.fn();
      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        const u = String(url);
        if (u.includes("routes.googleapis.com")) {
          routesSpy(new Headers(init?.headers).get("X-Goog-Api-Key"));
          return Promise.resolve(new Response(JSON.stringify(routesOk("600s", "500s")), { status: 200 }));
        }
        if (u.includes("geocoder")) {
          return Promise.resolve(new Response(JSON.stringify(geoHit()), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });

      await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

      // 解密失败视同未配置：既不应该调用 routes 端点，更不可能把密文当 key 发出去。
      expect(routesSpy).not.toHaveBeenCalled();
      const row = await rawTrafficRow("traffic_outbound");
      expect(row?.state).toBe("not_configured");
    },
  );
});

// F2：geocode 网络错误不该让整个 traffic 任务失败——地址方式仍然可用，
// TrafficRepository.kt 的原逻辑就是失败时退回地址；但 tick 主动取消（signal.aborted）
// 时必须照抛，不能吞掉「调度器要我们停下」的信号。
describe("trafficOutboundJob：geocode 失败时的降级", () => {
  it("geocode 网络错误（非中止）时仍以地址方式调用 computeRoute 并成功", async () => {
    const address = "Asker geo-network-error " + Math.random();
    await putSecret(env, "google_routes", "plain-real-key-123");
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });

    let routesBody: unknown = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) return Promise.reject(new TypeError("network error"));
      if (u.includes("routes.googleapis.com")) {
        return Promise.resolve(new Response(JSON.stringify(routesOk("600s", "500s")), { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    void routesBody;

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    const configKey = `${address.trim()}|Oslo S`;
    const snap = await getSnapshot(env, "traffic_outbound", configKey);
    expect(snap?.state).toBe("ok");
  });

  it("tick 主动取消（signal.aborted）时 geocode 的中止异常照常上抛，不吞掉", async () => {
    const address = "Asker geo-aborted " + Math.random();
    await putSecret(env, "google_routes", "plain-real-key-123");
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });

    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(new Response(JSON.stringify(routesOk("600s", "500s")), { status: 200 }));
    });

    // 中止属于「调度器要我们停下」，不该被 traffic 任务当成普通失败悄悄吞掉，
    // 必须让异常继续往上传（tick.ts 的处理器超时/取消保护会接住它）。
    await expect(trafficOutboundJob(env, WORK_NOW, controller.signal)).rejects.toThrow();
  });
});

describe("trafficOutboundJob：成功刷新", () => {
  it("a successfully decrypted google key is sent as-is to the Google Routes API", async () => {
    const address = "Asker key-header " + Math.random();
    mockFetch({ geo: geoHit(), routes: routesOk("600s", "500s") });
    await putSecret(env, "google_routes", "plain-real-key-123");
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });

    let sentKey: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = String(url);
      if (u.includes("routes.googleapis.com")) {
        sentKey = new Headers(init?.headers).get("X-Goog-Api-Key");
        return Promise.resolve(new Response(JSON.stringify(routesOk("600s", "500s")), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(geoHit()), { status: 200 }));
    });

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    expect(sentKey).toBe("plain-real-key-123");
  });

  it("fractional protobuf seconds are parsed instead of silently becoming zero; level is CLEAR", async () => {
    const address = "Asker fractional " + Math.random();
    await putSecret(env, "google_routes", "plain-real-key-123");
    mockFetch({ geo: geoHit(), routes: routesOk("10.5s", "9.5s") });
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    const configKey = `${address.trim()}|Oslo S`;
    const snap = await getSnapshot(env, "traffic_outbound", configKey);
    expect(snap?.state).toBe("ok");
    const data = snap?.data as { durationSec: number; staticDurationSec: number; delaySec: number; level: string };
    expect(data.durationSec).toBe(10);
    expect(data.staticDurationSec).toBe(9);
    expect(data.delaySec).toBe(1);
    expect(data.level).toBe("CLEAR");
  });

  it.each([
    ["CLEAR", "620s", "500s"], // delay 120s
    ["SLIGHT", "980s", "500s"], // delay 480s
    ["MODERATE", "1580s", "500s"], // delay 1080s
    ["SEVERE", "1581s", "500s"], // delay 1081s
  ])("delay thresholds map to level %s", async (expectedLevel, duration, staticDuration) => {
    const address = `Asker level ${expectedLevel} ${Math.random()}`;
    await putSecret(env, "google_routes", "plain-real-key-123");
    mockFetch({ geo: geoHit(), routes: routesOk(duration, staticDuration) });
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });

    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    const configKey = `${address.trim()}|Oslo S`;
    const snap = await getSnapshot(env, "traffic_outbound", configKey);
    expect((snap?.data as { level: string }).level).toBe(expectedLevel);
  });

  it("outbound writes origin→destination while return writes destination→origin", async () => {
    const origin = "Asker direction " + Math.random();
    const destination = "Oslo S";
    await putSecret(env, "google_routes", "plain-real-key-123");
    mockFetch({ geo: geoHit(), routes: routesOk("600s", "500s") });
    await setSettings({ originAddress: origin, destinationAddress: destination });

    await trafficReturnJob(env, RETURN_NOW, new AbortController().signal);

    const configKey = `${destination}|${origin.trim()}`;
    const snap = await getSnapshot(env, "traffic_return", configKey);
    expect(snap?.state).toBe("ok");
    const data = snap?.data as { origin: string; destination: string };
    expect(data.origin).toBe(destination);
    expect(data.destination).toBe(origin.trim());
  });

  it("Google 端 5xx → putFailure(upstream_5xx)，保留旧数据", async () => {
    const address = "Asker failure " + Math.random();
    await putSecret(env, "google_routes", "plain-real-key-123");
    await setSettings({ originAddress: address, destinationAddress: "Oslo S" });
    mockFetch({ geo: geoHit(), routes: routesOk("600s", "500s") });
    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    mockFetch({ geo: geoHit(), routesStatus: 500, routes: "internal error" });
    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    const configKey = `${address.trim()}|Oslo S`;
    const snap = await getSnapshot(env, "traffic_outbound", configKey);
    expect(snap?.state).toBe("stale");
    expect(snap?.error?.code).toBe("upstream_5xx");
    // 旧数据保留（putFailure 不清空 json）。
    expect((snap?.data as { durationSec: number }).durationSec).toBe(600);
  });
});

describe("weather 与 traffic 共享地理编码缓存", () => {
  it("weather and traffic refreshing the same origin share the geocoder cache", async () => {
    const origin = "Shared origin " + Math.random();
    const destination = "Shared destination " + Math.random();
    await putSecret(env, "google_routes", "plain-real-key-123");
    await setSettings({ originAddress: origin, destinationAddress: destination });

    let geoCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("geocoder")) {
        geoCalls += 1;
        return Promise.resolve(new Response(JSON.stringify(geoHit()), { status: 200 }));
      }
      if (u.includes("routes.googleapis.com")) {
        return Promise.resolve(new Response(JSON.stringify(routesOk("600s", "500s")), { status: 200 }));
      }
      // MET（天气）请求：随便给一个空 timeseries，天气任务本身的产出不是本用例关心的。
      return Promise.resolve(
        new Response(JSON.stringify({ properties: { timeseries: [] } }), { status: 200 }),
      );
    });

    await weatherJob(env, WORK_NOW, new AbortController().signal);
    await trafficOutboundJob(env, WORK_NOW, new AbortController().signal);

    // origin 只查一次（天气与路况共用），destination 一次：合计 2 次，而不是 3 次。
    expect(geoCalls).toBe(2);
  });
});
