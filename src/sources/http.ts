// 各数据源统一走这里发外部请求：负责超时、把 HTTP/网络故障归到契约里定义的
// 错误码（见 src/contract/dashboard.ts 的 SourceErrorSchema 注释），JSON 解析失败
// 同样归类，不把 fetch/JSON 的原生异常直接抛给调用方。

/** 与 SourceErrorSchema.code 对齐的四个取值（cpu_budget 由调用方自己判定，这里不产生）。 */
export type SourceFailureCode = "upstream_timeout" | "upstream_4xx" | "upstream_5xx" | "parse_error";

/** 数据源请求失败：code 用于写入快照的 error.code，message 供人读（日志/管理界面）。 */
export class SourceFailure extends Error {
  readonly code: SourceFailureCode;
  /**
   * 只有真正拿到了 HTTP 响应（非 2xx）时才设置；网络错误、超时等「压根没有响应」的
   * 失败没有这个字段。调用方（如 entur.ts 的 fetchGeocode）靠它区分「上游明确拒绝」
   * 与「请求本身没打通」——只有前者能安全地当成「查无结果」而不重新抛出（见 CONTRACT
   * 第 3 节「F2 geocode 吞异常」）。
   */
  readonly status?: number;

  constructor(code: SourceFailureCode, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SourceFailure";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
  }
}

export interface FetchJsonResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface FetchJsonOptions {
  /** 调度取消（tick 超时/手动中止）用的信号，与超时信号合并。 */
  signal?: AbortSignal;
  /** 单次请求超时，毫秒；不传则不设超时（仍受 signal 控制）。 */
  timeoutMs?: number;
  /**
   * 命中这些状态码时不当失败处理：直接返回 `{ status, headers, body: null }`，不尝试
   * 解析响应体为 JSON（该规范不允许带 body 的状态码，如 304，硬解析会出错）。
   * 供 met.ts 之类需要区分「明确的未变化」与「真正失败」的调用方使用（F5）。
   */
  passStatuses?: readonly number[];
}

/**
 * 发一次请求并把响应体当 JSON 解析。
 *
 * 失败一律抛 [SourceFailure]：
 * - 请求被中止/超时 → upstream_timeout
 * - 网络错误（DNS、连接被拒等，fetch 本身抛出而非返回响应）→ upstream_5xx
 *   （没有响应可归类，按「上游不可达」处理，与 5xx 语义最接近）
 * - HTTP 状态非 2xx → upstream_4xx / upstream_5xx（按状态码段区分）
 * - 响应体不是合法 JSON → parse_error
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  options: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs != null) signals.push(AbortSignal.timeout(options.timeoutMs));
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const fetchInit: RequestInit = { ...init };
  if (combinedSignal) fetchInit.signal = combinedSignal;

  // combinedSignal.aborted 是判断「这次失败是不是超时/取消」最可靠的信号：fetch 拒绝时
  // 抛出的异常不一定是 name === "AbortError" 的 DOMException——AbortSignal.timeout()
  // 产生的 reason 是 TimeoutError，workerd/undici 也可能直接把 signal.reason 原样抛出。
  // 组合信号已经 aborted，就说明是我们自己的超时/取消导致的失败，不是网络/上游故障。
  function isAbortFailure(err: unknown): boolean {
    if (combinedSignal?.aborted) return true;
    return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
  }

  let response: Response;
  try {
    response = await fetch(url, fetchInit);
  } catch (err) {
    if (isAbortFailure(err)) {
      throw new SourceFailure("upstream_timeout", `请求超时或被取消：${url}`, { cause: err });
    }
    throw new SourceFailure("upstream_5xx", `请求失败（网络错误）：${url}`, { cause: err });
  }

  if (options.passStatuses?.includes(response.status)) {
    // 该规范下这些状态码不允许带响应体（如 304），不去尝试 response.json()。
    return { status: response.status, headers: response.headers, body: null as T };
  }

  if (!response.ok) {
    const code: SourceFailureCode = response.status >= 400 && response.status < 500 ? "upstream_4xx" : "upstream_5xx";
    // 非 2xx 时我们不会读这个响应体：显式取消它，让底层连接尽快释放回连接池，不然
    // Workers 运行时会一直认为这个响应体「还有人可能会读」而攥着连接不放（F8）。
    await response.body?.cancel();
    throw new SourceFailure(code, `HTTP ${response.status}：${url}`, { status: response.status });
  }

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch (err) {
    // 读响应体途中（json() 解析前的流读取）被中止，同样归为超时，不是「响应不是合法 JSON」。
    if (isAbortFailure(err)) {
      throw new SourceFailure("upstream_timeout", `请求超时或被取消（读响应体途中）：${url}`, { cause: err });
    }
    throw new SourceFailure("parse_error", `响应不是合法 JSON：${url}`, { cause: err });
  }

  return { status: response.status, headers: response.headers, body };
}
