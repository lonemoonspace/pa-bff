// 契约统一的错误响应格式：{ error: { code, message } }。
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 输出契约格式的错误响应。
 * extra 用于携带错误体里的额外字段（例如 409 revision_conflict 的 current、
 * 422 invalid_settings 的 issues），与 error 对象同级合并进响应体。
 */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return c.json(
    {
      error: { code, message },
      ...(extra ?? {}),
    },
    status,
  );
}
