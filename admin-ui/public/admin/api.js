// @ts-check
// 对 /admin/api 的所有请求都经过这里：自动带 X-PA-Admin 头（CSRF 校验用）、
// JSON 序列化/反序列化，并把契约错误响应转成 ApiError，方便页面统一处理。
// 页面脚本一律用这里的函数，不直接调 fetch。

/** 契约错误响应 { error: { code, message } } 对应的异常。 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} body
   */
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let sessionExpiredShown = false;

function showSessionExpired() {
  if (sessionExpiredShown) return;
  sessionExpiredShown = true;
  const main = document.getElementById("main");
  if (!main) return;
  main.textContent = "";
  const p = document.createElement("p");
  p.textContent = "登录已过期，请刷新页面";
  main.appendChild(p);
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
export function apiGet(path) {
  return apiSend("GET", path);
}

/**
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<any>}
 */
export async function apiSend(method, path, body, headers) {
  /** @type {Record<string, string>} */
  const reqHeaders = { "X-PA-Admin": "1", ...(headers ?? {}) };
  /** @type {RequestInit} */
  const init = { method, headers: reqHeaders };
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);

  if (res.status === 401) {
    showSessionExpired();
  }

  if (res.status === 204) {
    return null;
  }

  const text = await res.text();
  /** @type {any} */
  let data = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const code = data && data.error && typeof data.error.code === "string" ? data.error.code : "unknown_error";
    const message = data && data.error && typeof data.error.message === "string" ? data.error.message : "请求失败";
    throw new ApiError(res.status, code, message, data);
  }

  return data;
}
