// 配对码生成 + 兑换：createPairCode() / redeemPairCode()。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPairCode, normalizePairCode, redeemPairCode } from "../../src/auth/pair";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM pair_codes");
});

describe("配对码", () => {
  it("生成后立即兑换 → 201，返回 viewer 令牌，且不能重复使用", async () => {
    const created = await createPairCode(env, "owner-device-id");
    expect(created.code).toHaveLength(8);

    const first = await redeemPairCode(env, { code: created.code, deviceName: "平板" });
    expect(first.status).toBe(201);
    if (first.status !== 201) throw new Error("unreachable");
    expect(first.body.role).toBe("viewer");

    const second = await redeemPairCode(env, { code: created.code, deviceName: "另一台" });
    expect(second.status).toBe(401);
    if (second.status !== 401) throw new Error("unreachable");
    expect(second.code).toBe("bad_pair_code");

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);
  });

  it("过期配对码 → 401 bad_pair_code", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = await createPairCode(env, "owner-device-id", now);
    const later = new Date(now.getTime() + 11 * 60 * 1000); // 11 分钟后，超过 10 分钟有效期
    const result = await redeemPairCode(env, { code: created.code, deviceName: "平板" }, later);
    expect(result.status).toBe(401);
    if (result.status !== 401) throw new Error("unreachable");
    expect(result.code).toBe("bad_pair_code");
  });

  it("不存在的配对码 → 401 bad_pair_code", async () => {
    const result = await redeemPairCode(env, { code: "ZZZZZZZZ", deviceName: "平板" });
    expect(result.status).toBe(401);
  });

  it("G2 修复 8：小写加连字符/易混淆字符的配对码也能兑换成功", async () => {
    const created = await createPairCode(env, "owner-device-id");
    // 用小写、加连字符、把 0/O 1/I/L 混用的写法模拟人工抄写。
    const messy = created.code
      .toLowerCase()
      .split("")
      .map((ch, i) => (i > 0 && i % 3 === 0 ? `-${ch}` : ch))
      .join("");
    const result = await redeemPairCode(env, { code: messy, deviceName: "手抄设备" });
    expect(result.status).toBe(201);
  });

  it("G2 修复 8：normalizePairCode 转大写、I/L→1、O→0、去空格和连字符", () => {
    expect(normalizePairCode("7k3p-xq2m")).toBe("7K3PXQ2M");
    expect(normalizePairCode("io lo")).toBe("1010");
    expect(normalizePairCode(" AB-CD ")).toBe("ABCD");
  });

  it("并发兑换同一配对码：只有一个成功", async () => {
    const created = await createPairCode(env, "owner-device-id");
    const [a, b] = await Promise.all([
      redeemPairCode(env, { code: created.code, deviceName: "A" }),
      redeemPairCode(env, { code: created.code, deviceName: "B" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 401]);

    const rows = await env.DB.prepare("SELECT * FROM devices").all();
    expect(rows.results).toHaveLength(1);
  });
});
