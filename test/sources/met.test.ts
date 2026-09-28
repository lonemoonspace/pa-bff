// 对应 app/.../data/met/MetApiTest.kt 的每个用例（表征测试钉住的现状）：
//   builds path and formats lat lon with 4 decimals using US locale
//     → "格式化 URL：lat/lon 各 4 位小数（US locale）"
//   rounds half-up at the 4th decimal → "四舍五入到第 4 位小数（十进制字符串口径，非二进制精确值）"
//   formats negative coordinates with US locale minus sign → "负数坐标格式化"
//   sends the fixed User-Agent header → "请求头带固定 User-Agent"（值是 BFF 自己的标识，见 met.ts 顶部注释）
//   parses a real-world locationforecast envelope → "解析真实响应：字段与默认值"
//   missing properties key decodes to null properties instead of failing → "properties 缺失时不报错"
//   throws IOException with status code on http error（500） → "HTTP 5xx → SourceFailure(upstream_5xx)"
//   throws IOException with status code on 404 → "HTTP 4xx → SourceFailure(upstream_4xx)"
//   empty response body throws SerializationException → "空响应体 → SourceFailure(parse_error)"
//   malformed json body throws uncaught SerializationException → "非法 JSON → SourceFailure(parse_error)"
// 另外补充 Kotlin 没有的部分（BFF 特有的条件请求）：If-Modified-Since 请求头、304 → notModified、
// ETag/Last-Modified/Expires 透传。
import { afterEach, describe, expect, it, vi } from "vitest";
import locationforecast from "../fixtures/met/locationforecast.json";
import { fetchWeather, formatCoordinate } from "../../src/sources/met";
import { SourceFailure } from "../../src/sources/http";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

// 204/205/304 这几个状态码的 Response 规范上不允许带 body（fetch 的 Response
// 构造函数会直接抛错），304 的测试用例只关心响应头，这里按状态码分开处理。
const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

function mockFetchOnce(body: unknown, status = 200, headers: Record<string, string> = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const responseBody = NO_BODY_STATUSES.has(status) ? null : typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(responseBody, {
        status,
        headers: { "content-type": "application/json", ...headers },
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatCoordinate", () => {
  it("builds path and formats lat lon with 4 decimals using US locale", async () => {
    const calls = mockFetchOnce({});

    await fetchWeather(59.912345, 10.752345);

    expect(firstCall(calls).url).toBe(
      "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.9123&lon=10.7523",
    );
  });

  it("rounds half-up at the 4th decimal", () => {
    // 10.75235 的精确二进制值略小于十进制 10.75235，若按精确值四舍五入会得到 10.7523；
    // Java "%.4f" 走的是十进制字符串口径，四舍五入到 10.7524，这里必须与之一致。
    expect(formatCoordinate(59.91235)).toBe("59.9124");
    expect(formatCoordinate(10.75235)).toBe("10.7524");
  });

  it("formats negative coordinates with US locale minus sign", async () => {
    const calls = mockFetchOnce({});

    await fetchWeather(-21.9, -175.2);

    expect(firstCall(calls).url).toContain("lat=-21.9000&lon=-175.2000");
  });
});

describe("fetchWeather", () => {
  it("sends the fixed User-Agent header", async () => {
    const calls = mockFetchOnce({});

    await fetchWeather(59.9, 10.7);

    const headers = new Headers(firstCall(calls).init!.headers);
    expect(headers.get("User-Agent")).toBe("personal-assistant-bff/1.0 (cloudflare-worker, personal use)");
  });

  it("parses a real-world locationforecast envelope", async () => {
    mockFetchOnce(locationforecast);

    const result = await fetchWeather(59.9, 10.7);

    expect(result.notModified).toBe(false);
    const points = result.envelope?.properties?.timeseries;
    expect(points).toHaveLength(2);
    const first = points![0]!;
    expect(first.time).toBe("2026-09-08T12:00:00Z");
    expect(first.data?.instant?.details?.air_temperature).toBe(18.5);
    expect(first.data?.instant?.details?.wind_speed).toBe(3.2);
    expect(first.data?.instant?.details?.wind_from_direction).toBe(270.0);
    expect(first.data?.next_1_hours?.summary?.symbol_code).toBe("partlycloudy_day");
    expect(first.data?.next_1_hours?.details?.precipitation_amount).toBe(0.1);
    expect(first.data?.next_6_hours?.summary?.symbol_code).toBe("cloudy");
    expect(first.data?.next_6_hours?.details?.precipitation_amount).toBe(0.5);
    const second = points![1]!;
    // next_1_hours/next_6_hours 缺失时用默认 null 容错（不报错）。
    expect(second.data?.next_1_hours).toBeNull();
    expect(second.data?.next_6_hours).toBeNull();
  });

  it("missing properties key decodes to null properties instead of failing", async () => {
    mockFetchOnce({});

    const result = await fetchWeather(59.9, 10.7);

    expect(result.envelope?.properties).toBeNull();
  });

  it("throws SourceFailure(upstream_5xx) on http error", async () => {
    mockFetchOnce("internal error", 500);

    await expect(fetchWeather(59.9, 10.7)).rejects.toMatchObject({ code: "upstream_5xx" });
  });

  it("throws SourceFailure(upstream_4xx) on 404", async () => {
    mockFetchOnce("not found", 404);

    await expect(fetchWeather(59.9, 10.7)).rejects.toMatchObject({ code: "upstream_4xx" });
  });

  it("empty response body throws SourceFailure(parse_error)", async () => {
    mockFetchOnce("");

    await expect(fetchWeather(59.9, 10.7)).rejects.toBeInstanceOf(SourceFailure);
    mockFetchOnce("");
    await expect(fetchWeather(59.9, 10.7)).rejects.toMatchObject({ code: "parse_error" });
  });

  it("malformed json body throws SourceFailure(parse_error)", async () => {
    mockFetchOnce("not json");

    await expect(fetchWeather(59.9, 10.7)).rejects.toMatchObject({ code: "parse_error" });
  });

  it("带上 If-Modified-Since 请求头", async () => {
    const calls = mockFetchOnce({});

    await fetchWeather(59.9, 10.7, { ifModifiedSince: "Tue, 08 Sep 2026 12:00:00 GMT" });

    const headers = new Headers(firstCall(calls).init!.headers);
    expect(headers.get("If-Modified-Since")).toBe("Tue, 08 Sep 2026 12:00:00 GMT");
  });

  it("304 时返回 notModified=true，不解析响应体", async () => {
    mockFetchOnce("not valid json at all", 304, { "last-modified": "Tue, 08 Sep 2026 12:00:00 GMT" });

    const result = await fetchWeather(59.9, 10.7, { ifModifiedSince: "Tue, 08 Sep 2026 12:00:00 GMT" });

    expect(result.notModified).toBe(true);
    expect(result.envelope).toBeNull();
    expect(result.lastModified).toBe("Tue, 08 Sep 2026 12:00:00 GMT");
  });

  // F5：met.ts 应改用 http.ts 的 fetchJson（带 passStatuses: [304]）而不是自己重新实现
  // 一遍「发请求 + 归类错误」。超时行为应与 fetchJson 一致，归为 upstream_timeout。
  it("MET 超时 → SourceFailure(upstream_timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject((signal as AbortSignal).reason));
      });
    });

    await expect(fetchWeather(59.9, 10.7, { timeoutMs: 10 })).rejects.toMatchObject({ code: "upstream_timeout" });
  });

  it("透传 ETag / Last-Modified / Expires 响应头", async () => {
    mockFetchOnce(
      {},
      200,
      {
        etag: '"abc123"',
        "last-modified": "Tue, 08 Sep 2026 12:00:00 GMT",
        expires: "Tue, 08 Sep 2026 12:30:00 GMT",
      },
    );

    const result = await fetchWeather(59.9, 10.7);

    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBe("Tue, 08 Sep 2026 12:00:00 GMT");
    expect(result.expires).toBe("Tue, 08 Sep 2026 12:30:00 GMT");
  });
});
