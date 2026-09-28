import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

// Hono 的路由匹配器在第一次处理请求时惰性构建，构建完成后就不能再 add 新路由
// （SmartRouter「matcher is already built」）。这个文件里其它用例会先触发 SELF.fetch，
// 所以测试专用的抛异常路由必须在模块加载时（任何 it() 真正跑起来、发出第一个请求之前）
// 就注册好，不能放在 it() 回调里临时加。
const G2_ERROR_PROBE_SECRET = "super-secret-value-should-not-leak";
app.get("/__test-throw", () => {
  throw new Error(`boom: ${G2_ERROR_PROBE_SECRET}`);
});

describe("GET /healthz", () => {
  it("返回 200 且 lastTickAt 为 null（P2 才接调度器）", async () => {
    const res = await SELF.fetch("https://bff.example/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastTickAt: null });
  });
});

describe("未知路由", () => {
  it("返回 404 且错误体符合契约格式", async () => {
    const res = await SELF.fetch("https://bff.example/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
  });
});

describe("全局错误处理（G2 修复 6）", () => {
  it("未捕获异常 → 500 internal_error，消息是固定通用文案，不回显异常内容", async () => {
    // 用模块顶层注册好的测试专用路由（见上方注释），断言 app.onError 把异常转成契约
    // 格式，且不泄露异常里的机密内容（这里放个假密钥当探针）。
    const res = await app.request("https://bff.example/__test-throw");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain(G2_ERROR_PROBE_SECRET);
    expect(body.error.message).not.toContain("boom");
  });
});
