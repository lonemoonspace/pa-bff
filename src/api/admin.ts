// 管理界面（/admin）总路由：Access 校验、CSRF 校验、未配置说明页、静态资源转发。
// 契约见 CONTRACT.md 第 2 节「管理界面」与第 8 节；外形见 src/contract/admin.ts。
//
// 全程用 route()（不是 mount()）：mount() 会把请求 URL 里的挂载前缀剥掉再转发，
// 页面静态资源转发（env.ASSETS.fetch(c.req.raw)）需要原始完整路径（例如
// /admin/index.html），一旦被剥掉就会 404；而且 mount() 子应用没有共享顶层
// app.onError，子应用内部抛出的异常会落到 Hono 默认的纯文本错误页，不符合
// CONTRACT 第 3 节「未捕获异常也要输出契约格式」。route() 会把子应用的路由直接
// 并入父应用的路由表（同一个 fetch 调度、同一个 onError），两个问题都不存在。
//
// 代价：route() 在被调用的那一刻把子应用**当前**的路由数组复制一份（Hono 源码
// `app.routes.map(...)`），之后再往子应用追加路由不会生效。所以新增子路由必须
// import 之后立刻调用（也可以直接紧跟在下面 adminApiApp 定义处追加），并且必须
// 写在本文件末尾 `adminApp.route("/api", adminApiApp)` 这一行**之前**：
//   import overviewApi from "./admin/overview";
//   adminApiApp.route("/overview", overviewApi);
//   （新子路由的 import 与 adminApiApp.route(...) 调用都加在这一行之上，
//    即 adminApp.route("/api", adminApiApp) 之前）
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AccessError, adminEnabled, verifyAccessJwt } from "../auth/access";
import type { Env } from "../env";
import { apiError } from "../util/errors";
// T7.2：总览页与「立即运行」，见 admin/overview.ts 文件头注释（D1 预算说明）。挂载调用
// 见下方 adminApiApp.route("/", overviewApi)（必须写在 adminApp.route("/api", ...) 之前）。
import overviewApi from "./admin/overview";
// T7.3：设备 / 日志 / 推送记录 / 测试推送，见对应文件头注释。挂载调用见下方
// adminApiApp.route("/", ...)（同样必须写在 adminApp.route("/api", ...) 之前）。
import devicesApi from "./admin/devices";
import logsApi from "./admin/logs";
import pushApi from "./admin/push";
// T7.4：设置表单 / 密钥 / 导出导入，见对应文件头注释。挂载调用见下方
// adminApiApp.route("/", ...)（同样必须写在 adminApp.route("/api", ...) 之前）。
import settingsApi from "./admin/settings";
import secretsApi from "./admin/secrets";

/** Access JWT 校验通过后的身份；actor 是审计日志里的操作者字符串（"admin:<email>"）。 */
export interface AdminIdentity {
  email: string;
  actor: string;
}

export type AdminVariables = { admin: AdminIdentity };

const PAGE_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const API_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const NOT_CONFIGURED_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8" /><title>管理界面未启用</title></head>
<body>
<h1>管理界面尚未启用</h1>
<p>需要在 Worker 的环境变量里同时设置 <code>ACCESS_TEAM_DOMAIN</code> 与 <code>ACCESS_AUD</code>
（Cloudflare Access 应用的团队域名与 AUD tag），详见项目 README。</p>
</body>
</html>`;

/**
 * 校验管理员身份：本地开发旁路（ADMIN_DEV_BYPASS="1" 且主机名为 localhost / 127.0.0.1）
 * 或 Cf-Access-Jwt-Assertion 的 Access JWT。校验失败抛 AccessError。
 */
async function authenticate(env: Env, req: Request): Promise<AdminIdentity> {
  const hostname = new URL(req.url).hostname;
  if (env.ADMIN_DEV_BYPASS === "1" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return { email: "dev@localhost", actor: "admin:dev@localhost" };
  }

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new AccessError("access_denied", "缺少 Access 凭证");
  }
  const { email } = await verifyAccessJwt(env, token, new Date());
  return { email, actor: `admin:${email}` };
}

/** /admin/api/* 专用：校验失败按 code 返回 401 access_denied 或 503 access_unavailable。 */
export const requireAdminApi = () =>
  createMiddleware<{ Bindings: Env; Variables: AdminVariables }>(async (c, next) => {
    try {
      const admin = await authenticate(c.env, c.req.raw);
      c.set("admin", admin);
    } catch (err) {
      if (err instanceof AccessError) {
        const status = err.code === "access_unavailable" ? 503 : 401;
        return apiError(c, status, err.code, "需要通过 Cloudflare Access 登录");
      }
      throw err;
    }
    await next();
  });

/**
 * CSRF 校验（CONTRACT 第 2 节）：Access 的会话 cookie 会随跨站请求带上，边缘会补上有效
 * JWT，签名有效不代表请求是本站发起的。非 GET 请求必须同时带 X-PA-Admin: 1 与匹配的 Origin。
 */
export const requireSameOrigin = () =>
  createMiddleware<{ Bindings: Env; Variables: AdminVariables }>(async (c, next) => {
    if (c.req.method !== "GET") {
      const adminHeader = c.req.header("X-PA-Admin");
      const origin = c.req.header("Origin");
      const requestOrigin = new URL(c.req.url).origin;
      if (adminHeader !== "1" || !origin || origin !== requestOrigin) {
        return apiError(c, 403, "csrf_rejected", "请求校验失败");
      }
    }
    await next();
  });

/** /admin/api 子路由：后续任务卡在此追加挂载（见文件头注释）。 */
export const adminApiApp = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

// 三个安全头对所有 /admin/api/* 响应生效，包含错误响应。
adminApiApp.use("*", async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    c.res.headers.set(name, value);
  }
});

adminApiApp.use("*", async (c, next) => {
  if (!adminEnabled(c.env)) {
    return apiError(c, 404, "not_found", "未找到该接口");
  }
  await next();
});

adminApiApp.use("*", requireAdminApi());
adminApiApp.use("*", requireSameOrigin());

adminApiApp.get("/me", (c) => c.json({ email: c.get("admin").email }));

adminApiApp.route("/", overviewApi);
adminApiApp.route("/", devicesApi);
adminApiApp.route("/", logsApi);
adminApiApp.route("/", pushApi);
adminApiApp.route("/", settingsApi);
adminApiApp.route("/", secretsApi);

adminApiApp.notFound((c) => apiError(c, 404, "not_found", "未找到该接口"));

/** 未经过鉴权中间件的静态页面 + 说明页；挂在 /admin 下（除 /admin/api/* 之外的一切）。 */
async function pageHandler(c: { env: Env; req: { raw: Request }; set: (k: "admin", v: AdminIdentity) => void }): Promise<Response> {
  const env = c.env;
  if (!adminEnabled(env)) {
    return new Response(NOT_CONFIGURED_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  try {
    const admin = await authenticate(env, c.req.raw);
    c.set("admin", admin);
  } catch (err) {
    if (err instanceof AccessError) {
      return new Response("需要通过 Cloudflare Access 登录", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw err;
  }

  const upstream = await env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(upstream.headers);
  for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

const adminApp = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

// 新增子路由的 import 与 adminApiApp.route(...) 调用要写在这一行之前（见文件头注释）。
adminApp.route("/api", adminApiApp);
adminApp.all("*", (c) => pageHandler(c));

export default adminApp;
