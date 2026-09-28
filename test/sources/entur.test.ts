// 对应 app/.../data/entur/EnturApiTest.kt 的每个用例：mock globalThis.fetch（vi.spyOn），
// 不访问真实网络。见 test/sources/http.test.ts 顶部注释：这个版本的 vitest-pool-workers
// 没有导出 fetchMock，改用 vi.spyOn。
import { afterEach, describe, expect, it, vi } from "vitest";
import departuresBothStops from "../fixtures/entur/departures-both-stops.json";
import geocodeAsker from "../fixtures/entur/geocode-asker.json";
import stopDeparturesLight from "../fixtures/entur/stop-departures-light.json";
import tripRailLegs from "../fixtures/entur/trip-rail-legs.json";
import {
  fetchBoth,
  fetchStop,
  fetchStopDepartures,
  fastestTrip,
  geocodeAddress,
} from "../../src/sources/entur";
import { SourceFailure } from "../../src/sources/http";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function mockFetchOnce(body: unknown, status = 200): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

function requestBody(call: RecordedCall): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(call.init!.body as string);
}

/** noUncheckedIndexedAccess 下 calls[0] 类型带 undefined；测试里断言过 toHaveLength 后取第一条一定存在。 */
function firstCall(calls: RecordedCall[]): RecordedCall {
  const call = calls[0];
  if (!call) throw new Error("expected at least one recorded fetch call");
  return call;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- fastestTrip ----

describe("fastestTrip", () => {
  it("POST 一份常量查询文本 + variables，id 与时刻都不进查询文本", async () => {
    const calls = mockFetchOnce({ data: { trip: { tripPatterns: [] } } });
    const at = new Date("2026-09-08T17:30:00.000Z");

    await fastestTrip("NSR:StopPlace:418", "NSR:StopPlace:337", at);

    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe("https://api.entur.io/journey-planner/v3/graphql");
    const body = requestBody(firstCall(calls));
    expect(body.query).toContain("query Trip($from: String!, $to: String!, $at: DateTime!)");
    expect(body.query).not.toContain("NSR:StopPlace:418");
    expect(body.variables).toEqual({
      from: "NSR:StopPlace:418",
      to: "NSR:StopPlace:337",
      at: at.toISOString(),
    });
  });

  it("敌意站点 id 只出现在 variables 里，不出现在查询文本里（防注入回归）", async () => {
    const calls = mockFetchOnce({ data: { trip: { tripPatterns: [] } } });
    const hostile = 'NSR:StopPlace:418") { name } evilInjected: stopPlace(id: "x';

    await fastestTrip(hostile, "NSR:StopPlace:337", new Date());

    const body = requestBody(firstCall(calls));
    expect(body.query).not.toContain("evilInjected");
    expect(body.query).not.toContain(hostile);
    expect(body.variables.from).toBe(hostile);
  });

  it("请求头带 ET-Client-Name 与 Content-Type: application/json", async () => {
    const calls = mockFetchOnce({ data: { trip: { tripPatterns: [] } } });

    await fastestTrip("A", "B", new Date());

    const headers = new Headers(firstCall(calls).init!.headers);
    expect(headers.get("ET-Client-Name")).toBe("personal-assistant-bff");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("解析出铁路腿，只保留 mode=rail，优先用 expected 时刻", async () => {
    mockFetchOnce(tripRailLegs);

    const itinerary = await fastestTrip("NSR:StopPlace:418", "NSR:StopPlace:337", new Date());

    expect(itinerary?.railLegs).toHaveLength(1);
    const leg = itinerary!.railLegs[0]!;
    expect(leg.line).toBe("R14");
    expect(leg.fromName).toBe("Asker");
    expect(leg.toName).toBe("Oslo S");
    expect(leg.depTime.toISOString()).toBe(new Date("2026-09-08T19:12:00+02:00").toISOString());
    expect(leg.arrTime.toISOString()).toBe(new Date("2026-09-08T19:41:00+02:00").toISOString());
  });

  it("expected 时刻缺失时回退到 aimed 时刻", async () => {
    mockFetchOnce({
      data: {
        trip: {
          tripPatterns: [
            {
              legs: [
                {
                  mode: "rail",
                  aimedStartTime: "2026-09-08T19:10:00+02:00",
                  aimedEndTime: "2026-09-08T19:40:00+02:00",
                  line: { publicCode: "R14" },
                  fromPlace: { name: "Asker" },
                  toPlace: { name: "Oslo S" },
                },
              ],
            },
          ],
        },
      },
    });

    const itinerary = await fastestTrip("A", "B", new Date());

    expect(itinerary?.railLegs[0]?.depTime.toISOString()).toBe(
      new Date("2026-09-08T19:10:00+02:00").toISOString(),
    );
  });

  it("挑第一个含铁路腿的 tripPattern，跳过全步行的候选", async () => {
    mockFetchOnce({
      data: {
        trip: {
          tripPatterns: [
            {
              legs: [
                {
                  mode: "foot",
                  aimedStartTime: "2026-09-08T19:00:00+02:00",
                  aimedEndTime: "2026-09-08T19:05:00+02:00",
                },
              ],
            },
            {
              legs: [
                {
                  mode: "rail",
                  aimedStartTime: "2026-09-08T19:10:00+02:00",
                  aimedEndTime: "2026-09-08T19:40:00+02:00",
                  line: { publicCode: "R14" },
                  fromPlace: { name: "Asker" },
                  toPlace: { name: "Oslo S" },
                },
              ],
            },
          ],
        },
      },
    });

    const itinerary = await fastestTrip("A", "B", new Date());

    expect(itinerary?.railLegs).toHaveLength(1);
  });

  it("所有 tripPattern 都不含铁路腿时返回 null", async () => {
    mockFetchOnce({
      data: {
        trip: {
          tripPatterns: [
            {
              legs: [
                {
                  mode: "foot",
                  aimedStartTime: "2026-09-08T19:00:00+02:00",
                  aimedEndTime: "2026-09-08T19:05:00+02:00",
                },
              ],
            },
          ],
        },
      },
    });

    expect(await fastestTrip("A", "B", new Date())).toBeNull();
  });

  it("GraphQL errors 数组时抛 SourceFailure(upstream_4xx)", async () => {
    mockFetchOnce({ data: null, errors: [{ message: "invalid stop place" }] });

    await expect(fastestTrip("BAD", "B", new Date())).rejects.toMatchObject({
      code: "upstream_4xx",
    });
  });

  it("HTTP 5xx 时抛 SourceFailure(upstream_5xx)", async () => {
    mockFetchOnce("server error", 500);

    await expect(fastestTrip("A", "B", new Date())).rejects.toMatchObject({
      code: "upstream_5xx",
    });
  });

  it("响应体为空/非法 JSON 时抛 SourceFailure(parse_error)（Kotlin 端是未包装异常，这里统一走 http.ts 的分类）", async () => {
    mockFetchOnce("");

    await expect(fastestTrip("A", "B", new Date())).rejects.toBeInstanceOf(SourceFailure);
    mockFetchOnce("");
    await expect(fastestTrip("A", "B", new Date())).rejects.toMatchObject({ code: "parse_error" });
  });
});

// ---- geocodeAddress ----

describe("geocodeAddress", () => {
  it("URL 用 URLEncoder 风格编码：空格转 + 而非 %20，带 lang=no", async () => {
    const calls = mockFetchOnce({ features: [] });

    await geocodeAddress("Asker torg 1 " + Math.random());

    expect(firstCall(calls).url).toContain("lang=no");
    expect(firstCall(calls).url).toContain("Asker+torg+1");
    expect(firstCall(calls).url).not.toContain("%20");
  });

  it("非 ASCII 字符按 UTF-8 百分号编码", async () => {
    const calls = mockFetchOnce({ features: [] });

    await geocodeAddress("Grønland " + Math.random());

    expect(firstCall(calls).url).toContain("Gr%C3%B8nland");
  });

  it("请求头带 ET-Client-Name", async () => {
    const calls = mockFetchOnce({ features: [] });

    await geocodeAddress("Oslo " + Math.random());

    expect(new Headers(firstCall(calls).init!.headers).get("ET-Client-Name")).toBe("personal-assistant-bff");
  });

  it("把 GeoJSON 的 [lon, lat] 换成 (lat, lon)", async () => {
    mockFetchOnce(geocodeAsker);

    const result = await geocodeAddress("Asker stasjon " + Math.random());

    expect(result).toEqual({ lat: 59.8331, lon: 10.4356 });
  });

  it("HTTP 错误时静默返回 null（不抛异常）", async () => {
    mockFetchOnce("server error", 500);

    expect(await geocodeAddress("nowhere-http-error " + Math.random())).toBeNull();
  });

  // F2：网络层面的失败（没有拿到任何 HTTP 响应，SourceFailure 没有 status）不该被静默
  // 吞掉——那不是「地址查不到」，是请求根本没打通，调用方（天气/路况任务）需要知道
  // 这次刷新真的失败了，而不是误当成「地理编码没有结果」。
  it("fetch 抛出网络错误（无 HTTP 响应）时以 upstream_5xx 拒绝，而不是静默返回 null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network error"));

    await expect(geocodeAddress("nowhere-network-error " + Math.random())).rejects.toMatchObject({
      code: "upstream_5xx",
    });
  });

  it("网络错误不入缓存（下次仍会重试并同样以异常拒绝）", async () => {
    const address = "nowhere-network-error-cache " + Math.random();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network error"));

    await expect(geocodeAddress(address)).rejects.toMatchObject({ code: "upstream_5xx" });
    await expect(geocodeAddress(address)).rejects.toMatchObject({ code: "upstream_5xx" });
  });

  it("JSON 解析失败时返回 null 而不是抛异常", async () => {
    mockFetchOnce("not json");

    expect(await geocodeAddress("nowhere-bad-json " + Math.random())).toBeNull();
  });

  it("features 为空数组时返回 null", async () => {
    mockFetchOnce({ features: [] });

    expect(await geocodeAddress("nowhere-empty " + Math.random())).toBeNull();
  });

  it("coordinates 少于 2 个元素时返回 null", async () => {
    mockFetchOnce({ features: [{ geometry: { coordinates: [10.4356] } }] });

    expect(await geocodeAddress("nowhere-short-coords " + Math.random())).toBeNull();
  });

  it("同一地址复用缓存的坐标，不重复发请求", async () => {
    const address = "Asker stasjon cache " + Math.random();
    const calls = mockFetchOnce({ features: [{ geometry: { coordinates: [10.4356, 59.8331] } }] });

    const first = await geocodeAddress(address);
    const second = await geocodeAddress(address);

    expect(first).toEqual(second);
    expect(calls).toHaveLength(1);
  });

  it("失败的查询不入缓存，下次刷新会重试", async () => {
    const address = "Oslo retry " + Math.random();
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response("server error", { status: 500 }));
      return Promise.resolve(
        new Response(JSON.stringify({ features: [{ geometry: { coordinates: [10.4356, 59.8331] } }] }), {
          status: 200,
        }),
      );
    });

    expect(await geocodeAddress(address)).toBeNull();
    expect(await geocodeAddress(address)).not.toBeNull();
    expect(call).toBe(2);
  });

  it("缓存有界：写满 64 个不同地址后整体清空，之前缓存的地址需要重新查", async () => {
    const prefix = "bound-test-" + Math.random() + "-";
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ features: [{ geometry: { coordinates: [10.4356, 59.8331] } }] }), {
          status: 200,
        }),
      );
    });

    await geocodeAddress(`${prefix}first`);
    for (let i = 0; i < 64; i++) {
      await geocodeAddress(`${prefix}address-${i}`);
    }
    expect(requestCount).toBe(65);

    // 缓存已被清空，第一个地址需要重新查。
    await geocodeAddress(`${prefix}first`);
    expect(requestCount).toBe(66);
  });
});

// ---- fetchStop / fetchBoth ----

describe("fetchStop", () => {
  it("单别名查询，id 与起查时刻都走 variables，默认 rangeMinutes=180、maxCalls=120", async () => {
    const calls = mockFetchOnce({ data: { stopA: { name: "Asker", estimatedCalls: [] } } });
    const from = new Date("2026-09-08T06:00:00.000Z");

    await fetchStop("NSR:StopPlace:418", from);

    const body = requestBody(firstCall(calls));
    expect(body.query).toContain("query Departures(");
    expect(body.query).toContain("stopA: stopPlace(id: $stop_stopA)");
    expect(body.query).not.toContain("stopB");
    expect(body.query).not.toContain("NSR:StopPlace:418");
    expect(body.variables).toEqual({
      range: 10800,
      calls: 120,
      stop_stopA: "NSR:StopPlace:418",
      start_stopA: from.toISOString(),
    });
  });

  it("解析出站点名与班次（含线路、方向、realtime）", async () => {
    mockFetchOnce(departuresBothStops);

    const calls = await fetchStop("NSR:StopPlace:418", new Date());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.realtime).toBe(true);
    expect(calls[0]!.destinationDisplay?.frontText).toBe("Oslo S");
    expect(calls[0]!.serviceJourney?.journeyPattern?.line?.publicCode).toBe("R14");
  });

  it("GraphQL errors 数组时抛 SourceFailure(upstream_4xx)", async () => {
    mockFetchOnce({ data: null, errors: [{ message: "unknown stop" }] });

    await expect(fetchStop("BAD", new Date())).rejects.toMatchObject({ code: "upstream_4xx" });
  });

  it("HTTP 错误时抛 SourceFailure(upstream_5xx)", async () => {
    mockFetchOnce("server error", 500);

    await expect(fetchStop("A", new Date())).rejects.toMatchObject({ code: "upstream_5xx" });
  });

  it("响应体解析失败时抛 SourceFailure(parse_error)", async () => {
    mockFetchOnce("not json");

    await expect(fetchStop("A", new Date())).rejects.toMatchObject({ code: "parse_error" });
  });

  it("stopA 在响应里缺失时返回空列表", async () => {
    mockFetchOnce({ data: {} });

    expect(await fetchStop("A", new Date())).toEqual([]);
  });

  it("站点为退役 id（Entur 返回 null）时按空列表处理，而不是解析失败", async () => {
    mockFetchOnce({ data: { stopA: null } });

    expect(await fetchStop("RETIRED-ID", new Date())).toEqual([]);
  });
});

describe("fetchBoth", () => {
  it("两别名查询，各自的 id / 起查时刻是独立变量，range 与 calls 应用到两个别名", async () => {
    const calls = mockFetchOnce(departuresBothStops);
    const fromA = new Date("2026-09-08T06:00:00.000Z");
    const fromB = new Date("2026-09-08T06:05:00.000Z");

    await fetchBoth("NSR:StopPlace:418", "NSR:StopPlace:337", fromA, fromB, { rangeMinutes: 60, maxCalls: 10 });

    const body = requestBody(firstCall(calls));
    expect(body.query).toContain("stopA: stopPlace(id: $stop_stopA)");
    expect(body.query).toContain("stopB: stopPlace(id: $stop_stopB)");
    expect(body.variables).toEqual({
      range: 3600,
      calls: 10,
      stop_stopA: "NSR:StopPlace:418",
      start_stopA: fromA.toISOString(),
      stop_stopB: "NSR:StopPlace:337",
      start_stopB: fromB.toISOString(),
    });
  });

  it("返回一对 [stopA的班次, stopB的班次]", async () => {
    mockFetchOnce(departuresBothStops);

    const [callsA, callsB] = await fetchBoth("A", "B", new Date(), new Date());

    expect(callsA).toHaveLength(1);
    expect(callsB).toEqual([]);
  });
});

// ---- fetchStopDepartures（轻量查询）----

describe("fetchStopDepartures", () => {
  it("每个站点一个别名，轻量字段集，站点 id 只出现在 variables 里", async () => {
    const calls = mockFetchOnce(stopDeparturesLight);
    const from = new Date("2026-09-22T06:00:00.000Z");

    const result = await fetchStopDepartures(["NSR:StopPlace:59616", "NSR:StopPlace:90002"], from, {
      rangeMinutes: 30,
      maxCalls: 7,
    });

    const body = requestBody(firstCall(calls));
    expect(body.query).toContain("stop0: stopPlace(id: $stop0)");
    expect(body.query).toContain("stop1: stopPlace(id: $stop1)");
    // 轻量：不含 quay / 每班次全程站点字段。
    expect(body.query).not.toContain("quay");
    expect(body.query).not.toContain("estimatedCalls {");
    expect(body.query).not.toContain("NSR:StopPlace:59616");
    expect(body.variables).toEqual({
      start: from.toISOString(),
      range: 1800,
      calls: 7,
      stop0: "NSR:StopPlace:59616",
      stop1: "NSR:StopPlace:90002",
    });

    expect([...result.keys()].sort()).toEqual(["NSR:StopPlace:59616", "NSR:StopPlace:90002"]);
    expect(result.get("NSR:StopPlace:59616")?.[0]?.destinationDisplay?.frontText).toBe("Nordby");
    expect(result.get("NSR:StopPlace:90002")).toEqual([]);
  });

  it("空站点列表直接返回空 Map，不发请求", async () => {
    const calls = mockFetchOnce({});

    const result = await fetchStopDepartures([], new Date());

    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("响应缺失某个站点时，结果里不包含该站点（而不是补一个空列表）", async () => {
    mockFetchOnce({ data: { stop0: { name: "Asker", estimatedCalls: [] } } });

    const result = await fetchStopDepartures(["A", "B"], new Date());

    expect([...result.keys()]).toEqual(["A"]);
  });

  it("站点为退役 id（返回 null）时按空结果处理，另一站不受影响", async () => {
    mockFetchOnce({
      data: { stop0: null, stop1: { name: "Nordby stasjon", estimatedCalls: [] } },
    });

    const result = await fetchStopDepartures(["RETIRED-ID", "NSR:StopPlace:90002"], new Date());

    expect([...result.keys()]).toEqual(["NSR:StopPlace:90002"]);
    expect(result.get("NSR:StopPlace:90002")).toEqual([]);
  });

  it("GraphQL errors 数组时抛 SourceFailure(upstream_4xx)", async () => {
    mockFetchOnce({ data: null, errors: [{ message: "unknown stop" }] });

    await expect(fetchStopDepartures(["BAD"], new Date())).rejects.toMatchObject({ code: "upstream_4xx" });
  });

  it("HTTP 错误时抛 SourceFailure(upstream_5xx)", async () => {
    mockFetchOnce("server error", 500);

    await expect(fetchStopDepartures(["A"], new Date())).rejects.toMatchObject({ code: "upstream_5xx" });
  });
});
