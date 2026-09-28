// /admin* 的集成测试：Access 校验、CSRF 校验、未配置时的行为、页面转发的安全头。
// 页面请求用假的 ASSETS: { fetch } 记录调用次数，不真正读磁盘上的静态文件。
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import type { Env } from "../../src/env";
import { resetAccessCacheForTest } from "../../src/auth/access";
import { requireAdminApi, requireSameOrigin, type AdminVariables } from "../../src/api/admin";
import { makeAccessTestKey, mockAccessJwks, signAccessJwt } from "../helpers/access-mock";

const DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";

function fakeAssets(status = 200, body = "<html>ok</html>") {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (req: Request): Promise<Response> => {
      calls.push(req);
      return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  };
}

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD, ...overrides } as unknown as Env;
}

function unconfiguredEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined, ...overrides } as unknown as Env;
}

async function validToken(key: Awaited<ReturnType<typeof makeAccessTestKey>>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signAccessJwt({ iss: `https://${DOMAIN}`, aud: AUD, exp: now + 3600, email: "admin@example.com" }, key);
}

beforeEach(() => {
  resetAccessCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessCacheForTest();
});

describe("未配置 Access", () => {
  it("/admin → 200 html 且含 ACCESS_TEAM_DOMAIN，ASSETS 0 次调用", async () => {
    const assets = fakeAssets();
    const testEnv = unconfiguredEnv({ ASSETS: assets as unknown as Fetcher });
    const res = await app.request("https://bff.example/admin", {}, testEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ACCESS_TEAM_DOMAIN");
    expect(assets.calls.length).toBe(0);
  });

  it("/admin/api/me → 404 not_found", async () => {
    const testEnv = unconfiguredEnv();
    const res = await app.request("https://bff.example/admin/api/me", {}, testEnv);
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("只设置了一个变量也算未配置", async () => {
    const testEnv = unconfiguredEnv({ ACCESS_TEAM_DOMAIN: DOMAIN });
    const res = await app.request("https://bff.example/admin/api/me", {}, testEnv);
    expect(res.status).toBe(404);
  });
});

describe("已配置 Access：页面转发", () => {
  it("校验失败 → 403 且 ASSETS 0 次调用", async () => {
    const assets = fakeAssets();
    const testEnv = configuredEnv({ ASSETS: assets as unknown as Fetcher });
    const res = await app.request("https://bff.example/admin", {}, testEnv);
    expect(res.status).toBe(403);
    expect(assets.calls.length).toBe(0);
  });

  it("校验通过 → ASSETS 1 次调用，响应带安全头", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const assets = fakeAssets();
    const testEnv = configuredEnv({ ASSETS: assets as unknown as Fetcher });

    const res = await app.request("https://bff.example/admin", { headers: { "Cf-Access-Jwt-Assertion": token } }, testEnv);
    expect(res.status).toBe(200);
    expect(assets.calls.length).toBe(1);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /admin/api/me", () => {
  it("合法 JWT → 200，email 正确", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();

    const res = await app.request("https://bff.example/admin/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json<{ email: string }>();
    expect(body.email).toBe("admin@example.com");
  });

  it("缺少请求头 → 401 access_denied，响应体不含 JWT 文本", async () => {
    const testEnv = configuredEnv();
    const res = await app.request("https://bff.example/admin/api/me", {}, testEnv);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("access_denied");
  });

  it("JWKS 取失败 → 503 access_unavailable", async () => {
    const key = await makeAccessTestKey("kid-1");
    const token = await validToken(key);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    const testEnv = configuredEnv();
    const res = await app.request(
      "https://bff.example/admin/api/me",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      testEnv,
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("access_unavailable");
  });

  it("三个安全头存在", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await app.request("https://bff.example/admin/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }, testEnv);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("页面转发保留完整路径（route() 不剥前缀）", () => {
  it("开发旁路下 /admin/index.html → 传给 ASSETS 的 pathname 是 /admin/index.html", async () => {
    const assets = fakeAssets();
    const testEnv = configuredEnv({ ADMIN_DEV_BYPASS: "1", ASSETS: assets as unknown as Fetcher });
    const res = await app.request("http://localhost/admin/index.html", {}, testEnv);
    expect(res.status).toBe(200);
    expect(assets.calls.length).toBe(1);
    expect(new URL(assets.calls[0]!.url).pathname).toBe("/admin/index.html");
  });

  it("开发旁路下 /admin/ → 传给 ASSETS 的 pathname 是 /admin/", async () => {
    const assets = fakeAssets();
    const testEnv = configuredEnv({ ADMIN_DEV_BYPASS: "1", ASSETS: assets as unknown as Fetcher });
    const res = await app.request("http://localhost/admin/", {}, testEnv);
    expect(res.status).toBe(200);
    expect(assets.calls.length).toBe(1);
    expect(new URL(assets.calls[0]!.url).pathname).toBe("/admin/");
  });
});

describe("页面转发时 ASSETS 抛异常", () => {
  it("→ 500 契约格式，不回显异常内容", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const secretProbe = "assets-boom-should-not-leak";
    const throwingAssets = {
      fetch: async (): Promise<Response> => {
        throw new Error(`boom: ${secretProbe}`);
      },
    };
    const testEnv = configuredEnv({ ASSETS: throwingAssets as unknown as Fetcher });
    const res = await app.request("https://bff.example/admin", { headers: { "Cf-Access-Jwt-Assertion": token } }, testEnv);
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain(secretProbe);
    expect(body.error.message).not.toContain("boom");
  });
});

describe("开发旁路", () => {
  it("localhost + ADMIN_DEV_BYPASS=1 → dev@localhost", async () => {
    const testEnv = configuredEnv({ ADMIN_DEV_BYPASS: "1" });
    const res = await app.request("http://localhost/admin/api/me", {}, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json<{ email: string }>();
    expect(body.email).toBe("dev@localhost");
  });

  it("同样变量但主机为 bff.example.com → 401", async () => {
    const testEnv = configuredEnv({ ADMIN_DEV_BYPASS: "1" });
    const res = await app.request("https://bff.example.com/admin/api/me", {}, testEnv);
    expect(res.status).toBe(401);
  });

  it("变量为 \"true\" → 401", async () => {
    const testEnv = configuredEnv({ ADMIN_DEV_BYPASS: "true" });
    const res = await app.request("http://localhost/admin/api/me", {}, testEnv);
    expect(res.status).toBe(401);
  });
});

// CSRF 校验：不借用生产的 adminApiApp（route() 在挂载那一刻就复制了路由表，测试
// 无法再追加探针路由），而是用同样的中间件另建一个独立的 Hono 测试应用。
function buildCsrfProbeApp() {
  const probeApp = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
  probeApp.use("*", requireAdminApi());
  probeApp.use("*", requireSameOrigin());
  probeApp.get("/probe", (c) => c.json({ ok: true }));
  probeApp.post("/probe", (c) => c.json({ ok: true }));
  return probeApp;
}

describe("CSRF 校验（非 GET）", () => {
  it("缺 X-PA-Admin → 403 csrf_rejected", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await buildCsrfProbeApp().request(
      "https://bff.example/probe",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, Origin: "https://bff.example" } },
      testEnv,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("csrf_rejected");
  });

  it("缺 Origin → 403", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await buildCsrfProbeApp().request(
      "https://bff.example/probe",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "X-PA-Admin": "1" } },
      testEnv,
    );
    expect(res.status).toBe(403);
  });

  it("Origin 不同 → 403", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await buildCsrfProbeApp().request(
      "https://bff.example/probe",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token, "X-PA-Admin": "1", Origin: "https://evil.example" },
      },
      testEnv,
    );
    expect(res.status).toBe(403);
  });

  it("两者都对 → 通过", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await buildCsrfProbeApp().request(
      "https://bff.example/probe",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token, "X-PA-Admin": "1", Origin: "https://bff.example" },
      },
      testEnv,
    );
    expect(res.status).toBe(200);
  });

  it("GET 不检查 CSRF", async () => {
    const key = await makeAccessTestKey("kid-1");
    mockAccessJwks(DOMAIN, [key]);
    const token = await validToken(key);
    const testEnv = configuredEnv();
    const res = await buildCsrfProbeApp().request(
      "https://bff.example/probe",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      testEnv,
    );
    expect(res.status).toBe(200);
  });
});
