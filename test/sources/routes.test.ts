// 对应 app/.../data/google/GoogleRoutesApiTest.kt 的可移植用例：请求构造（端点、请求头、
// 地址/经纬度二选一的 body 形状、只取第一条路线）与响应解析（小数秒）。不逐字对齐 Kotlin
// 版各状态码的专属错误文案——统一走 fetchJson（P3 通用约定），错误只按契约的
// upstream_4xx/upstream_5xx/parse_error 分类，文案由 fetchJson 生成。
import { afterEach, describe, expect, it, vi } from "vitest";
import computeOk from "../fixtures/routes/compute-ok.json";
import { computeRoute, parseDurationSeconds } from "../../src/sources/routes";
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

function firstCall(calls: RecordedCall[]): RecordedCall {
  const call = calls[0];
  if (!call) throw new Error("expected at least one recorded fetch call");
  return call;
}

function requestBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.init!.body as string) as Record<string, unknown>;
}

const departureTime = new Date("2026-09-08T17:30:45.123Z");

const okRoute = computeOk;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeRoute", () => {
  it("posts to the configured endpoint path", async () => {
    const calls = mockFetchOnce(okRoute);

    await computeRoute({
      apiKey: "key-1",
      origin: "Asker stasjon",
      destination: "Oslo S",
      departureTime,
    });

    const call = firstCall(calls);
    expect(call.init?.method).toBe("POST");
    expect(call.url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
  });

  it("sends api key and field mask headers, not the api key as a query param", async () => {
    const calls = mockFetchOnce(okRoute);

    await computeRoute({ apiKey: "key-1", origin: "A", destination: "B", departureTime });

    const call = firstCall(calls);
    const headers = new Headers(call.init?.headers);
    expect(headers.get("X-Goog-Api-Key")).toBe("key-1");
    expect(headers.get("X-Goog-FieldMask")).toBe("routes.duration,routes.staticDuration,routes.distanceMeters");
    expect(call.url).not.toContain("key=key-1");
  });

  it("request body uses address objects when no lat lng is given", async () => {
    const calls = mockFetchOnce(okRoute);

    await computeRoute({ apiKey: "key-1", origin: "Asker stasjon", destination: "Oslo S", departureTime });

    const body = requestBody(firstCall(calls));
    expect((body.origin as { address: string }).address).toBe("Asker stasjon");
    expect((body.destination as { address: string }).address).toBe("Oslo S");
    expect(body.travelMode).toBe("DRIVE");
    expect(body.routingPreference).toBe("TRAFFIC_AWARE");
    expect(body.units).toBe("METRIC");
    expect(body.languageCode).toBe("zh-CN");
  });

  it("request body uses lat lng objects when provided for both origin and destination", async () => {
    const calls = mockFetchOnce(okRoute);

    await computeRoute({
      apiKey: "key-1",
      origin: "ignored",
      destination: "also ignored",
      originLatLng: { lat: 59.8331, lon: 10.4356 },
      destLatLng: { lat: 59.9111, lon: 10.7528 },
      departureTime,
    });

    const body = requestBody(firstCall(calls));
    const originLoc = (body.origin as { location: { latLng: { latitude: number; longitude: number } } }).location
      .latLng;
    expect(originLoc.latitude).toBeCloseTo(59.8331, 9);
    expect(originLoc.longitude).toBeCloseTo(10.4356, 9);
    expect((body.origin as Record<string, unknown>).address).toBeUndefined();
    expect((body.destination as Record<string, unknown>).address).toBeUndefined();
  });

  it("origin and destination lat lng usage are independent of each other", async () => {
    const calls = mockFetchOnce(okRoute);

    await computeRoute({
      apiKey: "key-1",
      origin: "ignored",
      destination: "Oslo S",
      originLatLng: { lat: 59.8331, lon: 10.4356 },
      departureTime,
    });

    const body = requestBody(firstCall(calls));
    expect(body.origin).toHaveProperty("location");
    expect((body.destination as { address: string }).address).toBe("Oslo S");
  });

  it("parses duration staticDuration and distanceMeters from the first route", async () => {
    mockFetchOnce({
      routes: [
        { duration: "1234s", staticDuration: "1100s", distanceMeters: 15200 },
        { duration: "9999s", staticDuration: "9999s", distanceMeters: 99999 },
      ],
    });

    const info = await computeRoute({ apiKey: "key-1", origin: "A", destination: "B", departureTime });

    expect(info.duration).toBe("1234s");
    expect(info.staticDuration).toBe("1100s");
    expect(info.distanceMeters).toBe(15200);
  });

  it("blank api key throws SourceFailure before sending a request", async () => {
    const calls = mockFetchOnce(okRoute);

    await expect(computeRoute({ apiKey: "  ", origin: "A", destination: "B", departureTime })).rejects.toThrow(
      SourceFailure,
    );

    expect(calls).toHaveLength(0);
  });

  it("403 is classified as upstream_4xx", async () => {
    mockFetchOnce("PERMISSION_DENIED", 403);

    await expect(computeRoute({ apiKey: "bad-key", origin: "A", destination: "B", departureTime })).rejects
      .toMatchObject({ code: "upstream_4xx" });
  });

  it("500 is classified as upstream_5xx", async () => {
    mockFetchOnce("internal error", 500);

    await expect(computeRoute({ apiKey: "key-1", origin: "A", destination: "B", departureTime })).rejects
      .toMatchObject({ code: "upstream_5xx" });
  });

  it("empty routes array throws a parse_error failure", async () => {
    mockFetchOnce({ routes: [] });

    await expect(computeRoute({ apiKey: "key-1", origin: "A", destination: "B", departureTime })).rejects
      .toMatchObject({ code: "parse_error" });
  });

  it("missing routes key also throws a parse_error failure", async () => {
    mockFetchOnce({});

    await expect(computeRoute({ apiKey: "key-1", origin: "A", destination: "B", departureTime })).rejects
      .toMatchObject({ code: "parse_error" });
  });
});

describe("parseDurationSeconds", () => {
  it("parses integer seconds", () => {
    expect(parseDurationSeconds("1234s")).toBe(1234);
  });

  it("parses fractional seconds instead of silently becoming zero", () => {
    expect(parseDurationSeconds("10.5s")).toBe(10);
    expect(parseDurationSeconds("9.5s")).toBe(9);
  });

  it("falls back to 0 when unparseable", () => {
    expect(parseDurationSeconds("not-a-duration")).toBe(0);
  });
});
