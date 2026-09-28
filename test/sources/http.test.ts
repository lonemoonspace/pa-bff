// fetchJson 的单测：mock globalThis.fetch（vi.spyOn），不访问真实网络。
// vitest-pool-workers 这个版本的 cloudflare:test 没有导出 fetchMock（undici MockAgent），
// 所以选 vi.spyOn(globalThis, "fetch")——workerd 里 fetch 是普通全局函数，spy 得住。
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, SourceFailure } from "../../src/sources/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJson", () => {
  it("成功时返回 status / headers / body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-custom": "1" },
      }),
    );

    const result = await fetchJson<{ hello: string }>("https://example.test/api");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hello: "world" });
    expect(result.headers.get("x-custom")).toBe("1");
  });

  it("4xx 状态码抛 SourceFailure(upstream_4xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 404 }));

    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({
      code: "upstream_4xx",
    });
  });

  it("5xx 状态码抛 SourceFailure(upstream_5xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server error", { status: 503 }));

    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({
      code: "upstream_5xx",
    });
  });

  it("响应体不是合法 JSON 抛 SourceFailure(parse_error)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({
      code: "parse_error",
    });
  });

  it("fetch 抛出 AbortError（超时/取消）时归为 upstream_timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const err = new DOMException("The operation was aborted", "AbortError");
      return Promise.reject(err);
    });

    await expect(fetchJson("https://example.test/api", {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "upstream_timeout",
    });
  });

  it("fetch 因网络错误抛出（非 AbortError）时归为 upstream_5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network error"));

    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({
      code: "upstream_5xx",
    });
  });

  // F1：组合信号（内部 timeoutMs 生成的 AbortSignal.timeout 与外部传入的 signal 用
  // AbortSignal.any 合并）中止时，fetch 拒绝时抛出的异常不一定是 name === "AbortError"
  // 的 DOMException——workerd/undici 有时用 signal.reason 原样拒绝（可能是
  // TimeoutError，也可能是别的东西）。只要 combinedSignal 本身已经 aborted，就该归为
  // upstream_timeout，不该退化成 upstream_5xx。
  it("内部 timeoutMs 触发的中止：fetch 以 signal.reason（非 AbortError）拒绝时仍归为 upstream_timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          // AbortSignal.timeout() 产生的 reason 是 TimeoutError，不是 AbortError。
          reject((signal as AbortSignal).reason);
        });
      });
    });

    await expect(fetchJson("https://example.test/api", {}, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "upstream_timeout",
    });
  });

  it("外部 AbortSignal.timeout(10) 触发的中止同样归为 upstream_timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject((signal as AbortSignal).reason);
        });
      });
    });

    await expect(
      fetchJson("https://example.test/api", {}, { signal: AbortSignal.timeout(10) }),
    ).rejects.toMatchObject({ code: "upstream_timeout" });
  });

  it("读响应体途中被中止同样归为 upstream_timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      const response = new Response("ok", { status: 200 });
      vi.spyOn(response, "json").mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          reject((signal as AbortSignal).reason ?? new DOMException("aborted", "AbortError"));
        });
      });
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(response));
        // 万一从未中止（测试写错了）也不会真的挂起：给个兜底。
        setTimeout(() => resolve(response), 50);
      });
    });

    await expect(fetchJson("https://example.test/api", {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "upstream_timeout",
    });
  });

  it("外部传入的 signal 已中止时，请求被中止并归为 upstream_timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal;
      // 已中止的 signal 不会再触发 "abort" 事件（早就 fire 过了），要先同步检查
      // aborted 标志——真实 fetch 实现（undici/workerd）就是这样处理已中止 signal 的。
      if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const controller = new AbortController();
    controller.abort();

    await expect(fetchJson("https://example.test/api", {}, { signal: controller.signal })).rejects.toBeInstanceOf(
      SourceFailure,
    );
  });

  // F8：非 2xx 响应体如果不读也不取消，workerd 会认为连接可能还要用，不释放回连接池。
  it("非 2xx 响应：显式取消响应体（连接释放）", async () => {
    const response = new Response("bad request", { status: 404 });
    const cancelSpy = vi.spyOn(response.body!, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(fetchJson("https://example.test/api")).rejects.toMatchObject({ code: "upstream_4xx" });

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("body / headers 之外的 init 字段（method、headers）原样传给 fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await fetchJson(
      "https://example.test/api",
      { method: "POST", headers: { "X-Test": "1" }, body: JSON.stringify({ a: 1 }) },
      { timeoutMs: 5000 },
    );

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("expected fetch to be called");
    const [url, init] = call;
    expect(url).toBe("https://example.test/api");
    expect((init as RequestInit).method).toBe("POST");
    expect(new Headers((init as RequestInit).headers).get("X-Test")).toBe("1");
  });
});
