// POST /v1/claim 的核心逻辑：claim()。路由层的 wiring 在 test/index.test.ts 之外
// 单独没有覆盖，因为 claim() 本身就是路由处理函数唯一的业务逻辑，直接测更精确、
// 也更容易注入「未配置 CLAIM_CODE」这种和全局测试绑定不同的场景。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claim } from "../../src/auth/claim";
import type { Env } from "../../src/env";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // 每个用例都要从「未认领」状态开始：清空认领相关的表。
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
});

const GOOD_BODY = { claimCode: env.CLAIM_CODE, deviceName: "我的手机" };

describe("claim()", () => {
  it("正确认领码 → 201，返回 owner 令牌", async () => {
    const result = await claim(env, GOOD_BODY);
    expect(result.status).toBe(201);
    if (result.status !== 201) throw new Error("unreachable");
    expect(result.body.role).toBe("owner");
    expect(result.body.token.startsWith("pa_")).toBe(true);
    expect(typeof result.body.deviceId).toBe("string");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);
  });

  it("第二次认领 → 409 already_claimed", async () => {
    const first = await claim(env, GOOD_BODY);
    expect(first.status).toBe(201);
    const second = await claim(env, { claimCode: env.CLAIM_CODE, deviceName: "另一台" });
    expect(second.status).toBe(409);
    if (second.status !== 409) throw new Error("unreachable");
    expect(second.code).toBe("already_claimed");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);
  });

  it("错误认领码 → 401 bad_claim_code", async () => {
    const result = await claim(env, { claimCode: "wrong-code", deviceName: "x" });
    expect(result.status).toBe(401);
    if (result.status !== 401) throw new Error("unreachable");
    expect(result.code).toBe("bad_claim_code");
  });

  it("15 分钟内第 6 次错误后锁定，之后即使认领码正确也返回 429 locked", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await claim(env, { claimCode: "wrong-code", deviceName: "x" });
      expect(r.status).toBe(401);
    }
    // 第 6 次：占用尝试时计数达到阈值，直接锁定，不再走到「比较认领码」那一步。
    const sixth = await claim(env, { claimCode: "wrong-code", deviceName: "x" });
    expect(sixth.status).toBe(429);

    const afterLock = await claim(env, GOOD_BODY);
    expect(afterLock.status).toBe(429);
    if (afterLock.status !== 429) throw new Error("unreachable");
    expect(afterLock.code).toBe("locked");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(0);
  });

  it("CLAIM_CODE 未配置 → 503 not_configured", async () => {
    // exactOptionalPropertyTypes 下不能显式赋值 undefined，用解构直接去掉这个字段。
    const { CLAIM_CODE: _claimCode, ...rest } = env;
    const envWithoutClaimCode = rest as Env;
    const result = await claim(envWithoutClaimCode, GOOD_BODY);
    expect(result.status).toBe(503);
    if (result.status !== 503) throw new Error("unreachable");
    expect(result.code).toBe("not_configured");
  });

  it("G2 修复 1：并发 20 次错误认领后，用正确认领码认领得到 429 locked，且 401 个数 ≤ 5", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claim(env, { claimCode: "wrong-code", deviceName: "x" })),
    );
    const count401 = results.filter((r) => r.status === 401).length;
    const count429 = results.filter((r) => r.status === 429).length;
    expect(count401).toBeLessThanOrEqual(5);
    expect(count401 + count429).toBe(20);

    const afterLock = await claim(env, GOOD_BODY);
    expect(afterLock.status).toBe(429);
    if (afterLock.status !== 429) throw new Error("unreachable");
    expect(afterLock.code).toBe("locked");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(0);
  });

  it("G2 修复 2：CLAIM_CODE 过短（< 12 位）视为未配置 → 503 not_configured", async () => {
    const envWithShortCode = { ...env, CLAIM_CODE: "short" } as Env;
    const result = await claim(envWithShortCode, GOOD_BODY);
    expect(result.status).toBe(503);
    if (result.status !== 503) throw new Error("unreachable");
    expect(result.code).toBe("not_configured");
  });

  it("G2 修复 3：claimed_at 已非空时设备表不增加行（不依赖 changes()）", async () => {
    const first = await claim(env, GOOD_BODY);
    expect(first.status).toBe(201);
    const second = await claim(env, { claimCode: env.CLAIM_CODE, deviceName: "另一台" });
    expect(second.status).toBe(409);
    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);
  });

  it("G2 修复 7：认领码正确但 deviceName 不合法 → 422 invalid_device_name，不计入失败次数", async () => {
    const result = await claim(env, { claimCode: env.CLAIM_CODE, deviceName: "" });
    expect(result.status).toBe(422);
    if (result.status !== 422) throw new Error("unreachable");
    expect(result.code).toBe("invalid_device_name");

    // 不计入失败次数：紧接着用正确的 body 认领应该照常成功，不应该被判定为锁定。
    const ok = await claim(env, GOOD_BODY);
    expect(ok.status).toBe(201);
  });

  it("G3 修复 8：预置只有 claimed_at 的遗留 meta 时，正确认领码 → 409，设备表 0 行", async () => {
    // 模拟一种遗留/半成品状态：claimed_at 已经被写过（例如某次异常留下的），
    // 但 claimed_by 还是空的。正确的认领码这时也应该被当成「已认领」拒绝，
    // 而不是顺着 claimed_by 还是 NULL 把它补上、凭空造出一台设备。
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('claimed_at', ?)").bind(new Date().toISOString()).run();

    const result = await claim(env, GOOD_BODY);
    expect(result.status).toBe(409);
    if (result.status !== 409) throw new Error("unreachable");
    expect(result.code).toBe("already_claimed");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(0);
  });

  it("并发两次认领：只有一个成功，设备表只有一行", async () => {
    const [a, b] = await Promise.all([
      claim(env, { claimCode: env.CLAIM_CODE, deviceName: "手机 A" }),
      claim(env, { claimCode: env.CLAIM_CODE, deviceName: "手机 B" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);

    const metaRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'claimed_at'").first<{
      value: string;
    }>();
    expect(metaRow?.value).toBeTruthy();
  });
});
