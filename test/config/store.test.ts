// config/store 的单测：迁移已插入 revision=1 的初始行，这里主要验证乐观锁的
// 条件更新行为——重复用 D1 是真的（vitest-pool-workers），不 mock。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/contract/settings";
import { getSettingsRecord, putSettings } from "../../src/config/store";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("getSettingsRecord", () => {
  it("初始行 revision=1，json 可被 schema 解析出默认设置", async () => {
    const record = await getSettingsRecord(env);
    expect(record.revision).toBe(1);
    expect(record.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("putSettings", () => {
  it("revision 匹配时写入成功，revision +1", async () => {
    const before = await getSettingsRecord(env);
    const next = { ...before.settings, originStation: "Asker" };
    const result = await putSettings(env, before.revision, next, "device-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.revision).toBe(before.revision + 1);
      expect(result.record.settings.originStation).toBe("Asker");
    }

    const reread = await getSettingsRecord(env);
    expect(reread.revision).toBe(before.revision + 1);
    expect(reread.settings.originStation).toBe("Asker");
  });

  it("revision 过期时写入失败，返回 current 为最新值", async () => {
    const before = await getSettingsRecord(env);
    // 先用正确 revision 成功写一次，制造出“过期”场景。
    const ok = await putSettings(env, before.revision, { ...before.settings, originStation: "A" }, "device-1");
    expect(ok.ok).toBe(true);

    // 再用旧 revision 写，应当失败。
    const stale = await putSettings(env, before.revision, { ...before.settings, originStation: "B" }, "device-2");
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.current.settings.originStation).toBe("A");
      expect(stale.current.revision).toBe(before.revision + 1);
    }
  });

  it("并发两次 PUT 同一 revision，只有一个成功", async () => {
    const before = await getSettingsRecord(env);
    const [a, b] = await Promise.all([
      putSettings(env, before.revision, { ...before.settings, originStation: "First" }, "device-1"),
      putSettings(env, before.revision, { ...before.settings, originStation: "Second" }, "device-2"),
    ]);
    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
  });
});
