// notify_state 的读写：readStates 的缺行回退、commitStates 的条件 upsert 与并发钉子。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitStates, readStates } from "../../src/notify/state";
import { instrumentD1 } from "../helpers/d1-counter";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notify_state");
});

describe("readStates", () => {
  it("空表 → 四个策略 version 0、json null", async () => {
    const states = await readStates(env);
    expect(states.size).toBe(4);
    for (const policy of ["commute_disruption", "morning_brief", "football", "ticket"] as const) {
      expect(states.get(policy)).toEqual({ json: null, version: 0 });
    }
  });

  it("1 次查询", async () => {
    const instrumented = instrumentD1(env.DB);
    await readStates({ ...env, DB: instrumented.db });
    expect(instrumented.count()).toBe(1);
  });

  it("version 为 NULL 时按 0 处理", async () => {
    await env.DB.prepare("INSERT INTO notify_state (policy, state_json, version) VALUES (?, ?, NULL)")
      .bind("ticket", '{"keys":[]}')
      .run();
    const states = await readStates(env);
    expect(states.get("ticket")).toEqual({ json: '{"keys":[]}', version: 0 });
  });
});

describe("commitStates", () => {
  it("changes 为空 → 0 次查询、返回空集合", async () => {
    const instrumented = instrumentD1(env.DB);
    const result = await commitStates({ ...env, DB: instrumented.db }, []);
    expect(result).toEqual(new Set());
    expect(instrumented.count()).toBe(0);
  });

  it("首次提交插入 version 1", async () => {
    const result = await commitStates(env, [
      { policy: "ticket", json: '{"keys":["A"]}', expectedVersion: 0 },
    ]);
    expect(result).toEqual(new Set(["ticket"]));
    const states = await readStates(env);
    expect(states.get("ticket")).toEqual({ json: '{"keys":["A"]}', version: 1 });
  });

  it("正确 expectedVersion → 返回并 version+1", async () => {
    await commitStates(env, [{ policy: "ticket", json: '{"keys":["A"]}', expectedVersion: 0 }]);
    const result = await commitStates(env, [{ policy: "ticket", json: '{"keys":["B"]}', expectedVersion: 1 }]);
    expect(result).toEqual(new Set(["ticket"]));
    expect(await readStates(env).then((s) => s.get("ticket"))).toEqual({ json: '{"keys":["B"]}', version: 2 });
  });

  it("过期 expectedVersion → 不返回、行不变", async () => {
    await commitStates(env, [{ policy: "ticket", json: '{"keys":["A"]}', expectedVersion: 0 }]);
    const result = await commitStates(env, [{ policy: "ticket", json: '{"keys":["STALE"]}', expectedVersion: 0 }]);
    expect(result).toEqual(new Set());
    expect(await readStates(env).then((s) => s.get("ticket"))).toEqual({ json: '{"keys":["A"]}', version: 1 });
  });

  it("一条语句里两条成功一条失败 → 只返回两条", async () => {
    // 先把 football 和 ticket 各推进到 version 1，commute_disruption 保持缺行（version 0）。
    await commitStates(env, [
      { policy: "football", json: "{}", expectedVersion: 0 },
      { policy: "ticket", json: "{}", expectedVersion: 0 },
    ]);

    const result = await commitStates(env, [
      { policy: "commute_disruption", json: '{"fingerprint":null}', expectedVersion: 0 }, // 缺行，成功
      { policy: "football", json: '{"x":1}', expectedVersion: 1 }, // 正确版本，成功
      { policy: "ticket", json: '{"x":2}', expectedVersion: 0 }, // 版本过期，失败
    ]);

    expect(result).toEqual(new Set(["commute_disruption", "football"]));
  });

  it("D1 次数 = 1（无论 changes 有几条）", async () => {
    const instrumented = instrumentD1(env.DB);
    await commitStates({ ...env, DB: instrumented.db }, [
      { policy: "football", json: "{}", expectedVersion: 0 },
      { policy: "ticket", json: "{}", expectedVersion: 0 },
    ]);
    expect(instrumented.count()).toBe(1);
  });

  it("并发：两个执行拿同一 expectedVersion 先后提交 → 只有一个返回", async () => {
    await commitStates(env, [{ policy: "football", json: '{"v":0}', expectedVersion: 0 }]);

    const [a, b] = await Promise.all([
      commitStates(env, [{ policy: "football", json: '{"v":"a"}', expectedVersion: 1 }]),
      commitStates(env, [{ policy: "football", json: '{"v":"b"}', expectedVersion: 1 }]),
    ]);

    const totalReturned = [...a].length + [...b].length;
    expect(totalReturned).toBe(1);

    const finalVersion = await readStates(env).then((s) => s.get("football")?.version);
    expect(finalVersion).toBe(2);
  });

  it("缺行 + 并发插入（onPrepare 里先插入该行）→ 本次不返回", async () => {
    const instrumented = instrumentD1(env.DB, {
      onPrepare: async () => {
        // 模拟另一个执行「抢先」在本条语句真正执行前把这一行插入成 version 1。
        await env.DB.prepare(
          "INSERT INTO notify_state (policy, state_json, version) VALUES (?, ?, 1) ON CONFLICT(policy) DO NOTHING",
        )
          .bind("morning_brief", '{"lastSentDate":null}')
          .run();
      },
    });

    const result = await commitStates({ ...env, DB: instrumented.db }, [
      { policy: "morning_brief", json: '{"lastSentDate":"2026-01-01"}', expectedVersion: 0 },
    ]);

    expect(result).toEqual(new Set());
    const state = await readStates(env).then((s) => s.get("morning_brief"));
    expect(state).toEqual({ json: '{"lastSentDate":null}', version: 1 });
  });
});
