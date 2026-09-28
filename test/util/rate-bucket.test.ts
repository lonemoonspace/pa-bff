// takeToken 的单测：D1 是真的（vitest-pool-workers），验证原子扣减、补充、耗尽三条路径。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BUCKET_CAPACITY, takeToken } from "../../src/util/rate-bucket";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("takeToken", () => {
  it("首次调用（桶不存在）直接扣减成功", async () => {
    const name = "bucket-first-" + Math.random();
    const ok = await takeToken(env, name, new Date("2026-09-22T06:00:00.000Z"));
    expect(ok).toBe(true);
  });

  it("同一分钟内连续扣满容量后，下一次失败", async () => {
    const name = "bucket-drain-" + Math.random();
    const now = new Date("2026-09-22T06:00:00.000Z");
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      expect(await takeToken(env, name, now)).toBe(true);
    }
    expect(await takeToken(env, name, now)).toBe(false);
  });

  it("耗尽后按经过时间线性补充，够一个令牌就能再次成功", async () => {
    const name = "bucket-refill-" + Math.random();
    const now = new Date("2026-09-22T06:00:00.000Z");
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      expect(await takeToken(env, name, now)).toBe(true);
    }
    expect(await takeToken(env, name, now)).toBe(false);

    // 容量 10、每分钟补满：6 秒补 1 个令牌。
    const sixSecondsLater = new Date(now.getTime() + 6_000);
    expect(await takeToken(env, name, sixSecondsLater)).toBe(true);
    // 补充的那 1 个令牌刚被这次调用扣掉，紧接着再取应再次失败。
    expect(await takeToken(env, name, sixSecondsLater)).toBe(false);
  });

  it("补充不会超过桶容量：长时间未使用后仍只能连续取满容量次", async () => {
    const name = "bucket-cap-" + Math.random();
    const now = new Date("2026-09-22T06:00:00.000Z");
    expect(await takeToken(env, name, now)).toBe(true); // 消耗 1 个，剩 9 个

    const muchLater = new Date(now.getTime() + 60 * 60_000); // 1 小时后，理论上远超补满所需时间
    let successCount = 0;
    for (let i = 0; i < BUCKET_CAPACITY + 1; i++) {
      if (await takeToken(env, name, muchLater)) successCount++;
    }
    expect(successCount).toBe(BUCKET_CAPACITY);
  });

  it("不同名字的桶互不影响", async () => {
    const now = new Date("2026-09-22T06:00:00.000Z");
    const a = "bucket-a-" + Math.random();
    const b = "bucket-b-" + Math.random();
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      expect(await takeToken(env, a, now)).toBe(true);
    }
    expect(await takeToken(env, a, now)).toBe(false);
    expect(await takeToken(env, b, now)).toBe(true);
  });
});
