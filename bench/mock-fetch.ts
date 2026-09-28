// 基准脚本专用的 fetch 替身：只替 I/O（不发真实网络请求），响应内容一律来自
// test/fixtures 的真实录制响应（或本文件内联的、与录制响应同形状的小样本，用于
// test/fixtures 里没有现成文件覆盖的场景，例如关注线路卡片——见各 bench 文件里的说明）。
export interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type FetchHandler = (url: string, init: RequestInit | undefined) => MockResponseSpec;

let current: FetchHandler | null = null;
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!current) return originalFetch(input as never, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const spec = current(url, init);
    const bodyText = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    return new Response(bodyText, {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  }) as typeof fetch;
}

/**
 * 把 globalThis.fetch 换成给定的处理函数，跑完 `run` 再还原。
 *
 * 必须是 `async` 函数、用 `await run()`：如果只是 `return Promise.resolve(run())`，
 * `finally` 会在 `run()` 返回的 promise 还没 settle 时就同步执行（try/finally 不会等
 * try 块里 return 的 promise），导致 `current` 提前被还原成上一个值——`run` 内部真正
 * 发起 fetch 请求时早就不再命中这次的 handler，而是走到「没有替身」的兜底分支，
 * 悄悄打了真实网络请求。
 */
export async function withFetch<T>(handler: FetchHandler, run: () => Promise<T> | T): Promise<T> {
  ensureInstalled();
  const previous = current;
  current = handler;
  try {
    return await run();
  } finally {
    current = previous;
  }
}

/** 从 POST 请求体里取出 JSON（GraphQL 请求体固定是 { query, variables } 的 JSON 字符串）。 */
export function jsonBodyOf(init: RequestInit | undefined): { query?: string; variables?: Record<string, unknown> } {
  const raw = typeof init?.body === "string" ? init.body : "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> };
  } catch {
    return {};
  }
}
