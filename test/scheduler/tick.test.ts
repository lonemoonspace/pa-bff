// tick() 的集成测试：D1 是真的（vitest-pool-workers），不 mock。
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/contract/settings";
import { ALL_JOB_NAMES, nextRunAt } from "../../src/scheduler/cadence";
import { registerJob, resetRegistryForTest } from "../../src/scheduler/jobs";
import { tick } from "../../src/scheduler/tick";
import { instrumentD1 } from "../helpers/d1-counter";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // registry 是模块级单例：各用例注册的临时任务名会累积下来，每个用例开始前重置回
  // 「只有 housekeeping」，避免上一个用例注册的任务抢占本用例「最多 4 个」的名额。
  resetRegistryForTest();
  await env.DB.exec("DELETE FROM jobs");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM logs");
  await env.DB.exec("DELETE FROM push_log");
  await env.DB.exec("DELETE FROM pair_codes");
});

async function runTick(now: Date) {
  const ctx = createExecutionContext();
  const result = await tick(env, ctx, now);
  await waitOnExecutionContext(ctx);
  return result;
}

const NOW = new Date("2026-08-12T06:00:00.000Z");

describe("首次运行播种", () => {
  it("为已注册任务（至少含 housekeeping）插入 jobs 行，并写 meta.last_tick_at", async () => {
    await runTick(NOW);
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE name = 'housekeeping'").first();
    expect(row).toBeTruthy();

    const meta = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_tick_at'").first<{
      value: string;
    }>();
    expect(meta?.value).toBe(NOW.toISOString());
  });
});

describe("单次 tick 最多 4 个任务", () => {
  it("即便有更多任务到期，一次 tick 也只执行 4 个", async () => {
    for (let i = 0; i < 5; i++) {
      registerJob(`test_cap_${i}`, async () => {});
    }
    const result = await runTick(NOW);
    expect(result.ran.length).toBeLessThanOrEqual(4);
    expect(result.ran.length).toBe(4);
  });
});

describe("租约：并发 tick 只有一个执行同一任务", () => {
  it("两次并发 tick 对同一个到期任务，只有一次真正执行", async () => {
    let runCount = 0;
    registerJob("test_lease_race", async () => {
      runCount += 1;
      // 模拟一点执行耗时，放大并发窗口。
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const [a, b] = await Promise.all([runTick(NOW), runTick(NOW)]);
    const totalRan = a.ran.filter((n) => n === "test_lease_race").length + b.ran.filter((n) => n === "test_lease_race").length;
    expect(totalRan).toBe(1);
    expect(runCount).toBe(1);
  });
});

describe("失败退避", () => {
  it("连续失败时 fail_count 与 next_run_at 间隔按 2/4/8/16/30/30 分钟推进", async () => {
    // 借用 housekeeping 这个已知任务名（registerJob 允许覆盖）：它必须是 cadence.ts
    // 认识的 JobName，正常间隔（到下一个本地 03:30）通常远大于退避分钟数，这样
    // min(正常间隔, 退避间隔) 才会稳定地选中退避间隔，真正测出退避序列。
    registerJob("housekeeping", async () => {
      throw new Error("boom");
    });

    const expected = [2, 4, 8, 16, 30, 30];
    let now = NOW;
    for (const minutes of expected) {
      const result = await runTick(now);
      expect(result.ran).toContain("housekeeping");

      const row = await env.DB.prepare("SELECT next_run_at, fail_count, last_status FROM jobs WHERE name = ?")
        .bind("housekeeping")
        .first<{ next_run_at: string; fail_count: number; last_status: string }>();
      expect(row?.last_status).toBe("error");

      const deltaMs = new Date(row?.next_run_at ?? 0).getTime() - now.getTime();
      expect(deltaMs).toBe(minutes * 60_000);

      // 推进到刚好到期的下一刻，再触发下一次 tick。
      now = new Date(now.getTime() + minutes * 60_000);
    }
  });

  it("成功一次后 fail_count 清零", async () => {
    let shouldFail = true;
    registerJob("test_recovers", async () => {
      if (shouldFail) throw new Error("boom");
    });

    const first = await runTick(NOW);
    expect(first.ran).toContain("test_recovers");
    const afterFail = await env.DB.prepare("SELECT fail_count FROM jobs WHERE name = ?")
      .bind("test_recovers")
      .first<{ fail_count: number }>();
    expect(afterFail?.fail_count).toBe(1);

    shouldFail = false;
    const failRow = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE name = ?")
      .bind("test_recovers")
      .first<{ next_run_at: string }>();
    const secondNow = new Date(failRow?.next_run_at ?? 0);
    const second = await runTick(secondNow);
    expect(second.ran).toContain("test_recovers");

    const afterOk = await env.DB.prepare("SELECT fail_count, last_status FROM jobs WHERE name = ?")
      .bind("test_recovers")
      .first<{ fail_count: number; last_status: string }>();
    expect(afterOk?.fail_count).toBe(0);
    expect(afterOk?.last_status).toBe("ok");
  });
});

describe("G3 修复 1：重复执行", () => {
  it("A 卡在 X 时 B 把 Y 跑完；A 恢复后继续遍历到 Y 也不会重复执行", async () => {
    // 这条测的不是 X（X 会一直卡到测试末尾才释放，A 的 for 循环里 X 后面的 Y 只有在
    // X 释放之后才会被继续处理），而是 Y：A 一开始的 due 列表里 [housekeeping, X, Y]
    // 是一次性取好的快照，A 卡在 X 上时，B 用 now+1 分钟把 Y 整个跑完并释放了租约、
    // 把 next_run_at 推到了未来。等 X 放行、A 的 for 循环继续往下走到 Y 时，如果
    // acquireLease 只看租约（旧代码），Y 的租约这时已经被 B 释放成 NULL，A 会用自己
    // 早已过期的 now 把 Y 再次抢到手、重新跑一遍——这正是「next_run_at <= now」这个
    // 条件要防住的重复执行。
    let runCountX = 0;
    let releaseX: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseX = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    registerJob("test_g3_dup_x", async () => {
      runCountX += 1;
      markEntered();
      await gate; // 永不主动 resolve，直到测试末尾释放
    });
    let yRan = 0;
    registerJob("test_g3_dup_y", async () => {
      yRan += 1;
    });

    const tickAPromise = runTick(NOW); // 不 await：处理到 X 时会卡住
    await entered; // 等到 A 真正抢到 X 的租约、预扣落库、并进了处理器

    const later = new Date(NOW.getTime() + 60_000); // now+1 分钟：X 的租约（120s）仍有效
    const b = await runTick(later);
    expect(b.ran).toContain("test_g3_dup_y");
    expect(b.ran).not.toContain("test_g3_dup_x");
    expect(yRan).toBe(1);

    releaseX(); // 放行 X，A 的 for 循环继续往下走到 Y
    const a = await tickAPromise;
    expect(a.ran).toContain("test_g3_dup_x");

    expect(runCountX).toBe(1);
    expect(yRan).toBe(1); // Y 不会被 A 重新执行第二遍
  });
});

describe("G3 修复 2：租约被别人接管后的覆盖", () => {
  it("租约过期后，后来的 tick 抢到租约；先来的 tick 写回时因租约不匹配而放弃", async () => {
    let invocation = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => {};
    const enteredFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    // 借用 notify（cadence.ts 认识的任务名，正常间隔只有 1 分钟）：失败第 1 次的退避
    // backoff(1)=2 分钟正好等于租约时长 120s，这样 now+121 秒时 next_run_at 与
    // lease_until 都已经「到期」，与 CONTRACT.md 第 5 节举的例子对应。用间隔很短的
    // notify 而不是 housekeeping，是因为 housekeeping 的目标时刻（下一个本地 03:30）
    // 对 121 秒的时间差不敏感，用它测不出「写回覆盖了谁的结果」。
    registerJob("notify", async () => {
      invocation += 1;
      if (invocation === 1) {
        firstEntered();
        await firstGate; // 第一次调用（tick A）永远卡住
      }
      // 第二次调用（tick B 抢到租约后）立刻成功返回。
    });

    const tickAPromise = runTick(NOW);
    await enteredFirst; // A 已经抢到租约、预扣落库，卡在处理器里

    const later = new Date(NOW.getTime() + 121_000); // now+121 秒：租约（120s）已过期
    const b = await runTick(later);
    expect(b.ran).toContain("notify");

    releaseFirst();
    await tickAPromise;

    const row = await env.DB.prepare("SELECT lease_until, next_run_at, fail_count FROM jobs WHERE name = ?")
      .bind("notify")
      .first<{ lease_until: string | null; next_run_at: string; fail_count: number }>();
    // 库里是 B 的结果：租约已释放、fail_count 清零、next_run_at 是 B 成功后算出的值
    // （now+121s 之后的 +1 分钟）；A 迟到的写回因为租约不匹配被放弃，不会把它覆盖成
    // A 自己那个基于旧 now 算出的值。
    expect(row?.lease_until).toBeNull();
    expect(row?.fail_count).toBe(0);
    expect(row?.next_run_at).toBe(nextRunAt("notify", later, DEFAULT_SETTINGS).toISOString());
  });
});

describe("G3 修复 3：预扣失败在处理器执行前已经落库", () => {
  it("处理器永不 resolve、tick 被丢弃，fail_count 与 next_run_at 间隔仍按 2、4 分钟推进", async () => {
    let markEntered1: () => void = () => {};
    const gate1 = new Promise<void>((resolve) => {
      markEntered1 = resolve;
    });
    registerJob("housekeeping", async () => {
      markEntered1();
      await new Promise<void>(() => {}); // 永不 resolve
    });

    const ctx1 = createExecutionContext();
    void tick(env, ctx1, NOW); // 故意不 await：这次 tick 直接丢弃
    await gate1;

    const row1 = await env.DB.prepare("SELECT fail_count, next_run_at, last_status FROM jobs WHERE name = 'housekeeping'")
      .first<{ fail_count: number; next_run_at: string; last_status: string }>();
    expect(row1?.fail_count).toBe(1);
    expect(row1?.last_status).toBe("running");
    expect(new Date(row1?.next_run_at ?? 0).getTime() - NOW.getTime()).toBe(2 * 60_000);

    let markEntered2: () => void = () => {};
    const gate2 = new Promise<void>((resolve) => {
      markEntered2 = resolve;
    });
    registerJob("housekeeping", async () => {
      markEntered2();
      await new Promise<void>(() => {});
    });

    const now2 = new Date(NOW.getTime() + 121_000); // 租约（120s）已过期，可以再抢一次
    const ctx2 = createExecutionContext();
    void tick(env, ctx2, now2);
    await gate2;

    const row2 = await env.DB.prepare("SELECT fail_count, next_run_at FROM jobs WHERE name = 'housekeeping'")
      .first<{ fail_count: number; next_run_at: string }>();
    expect(row2?.fail_count).toBe(2);
    expect(new Date(row2?.next_run_at ?? 0).getTime() - now2.getTime()).toBe(4 * 60_000);
  });
});

describe("G3 修复 5：CadenceCtx 接入", () => {
  it("处理器返回的 CadenceCtx 会传给 nextRunAt（weather 的 Expires）", async () => {
    const expiresAt = new Date(NOW.getTime() + 45 * 60_000);
    registerJob("weather", async () => ({ weatherExpiresAt: expiresAt }));

    const result = await runTick(NOW);
    expect(result.ran).toContain("weather");

    const row = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE name = 'weather'").first<{
      next_run_at: string;
    }>();
    expect(row?.next_run_at).toBe(expiresAt.toISOString());
  });
});

describe("G3 修复 7：设置解析失败", () => {
  it("settings.json 非法时回退到 DEFAULT_SETTINGS，tick 仍能执行并记一条 logs", async () => {
    await env.DB.prepare("UPDATE settings SET json = ? WHERE id = 1").bind("not valid json{").run();
    try {
      const result = await runTick(NOW);
      expect(result.ran).toContain("housekeeping");

      const logRow = await env.DB.prepare("SELECT level, source, message FROM logs ORDER BY id DESC LIMIT 1").first<{
        level: string;
        source: string;
        message: string;
      }>();
      expect(logRow?.level).toBe("error");
      expect(logRow?.source).toBe("scheduler");
    } finally {
      // 恢复默认设置，不影响本文件里其他用例。
      await env.DB.prepare("UPDATE settings SET json = ? WHERE id = 1").bind(JSON.stringify(DEFAULT_SETTINGS)).run();
    }
  });
});

describe("housekeeping", () => {
  it("清理 7 天前的 logs / push_log、过期的配对码，留下较新的记录", async () => {
    const oldIso = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const freshIso = new Date(NOW.getTime() - 1 * 24 * 3600 * 1000).toISOString();

    await env.DB.batch([
      env.DB.prepare("INSERT INTO logs (at, level, source, message) VALUES (?, 'info', 'test', 'old')").bind(oldIso),
      env.DB.prepare("INSERT INTO logs (at, level, source, message) VALUES (?, 'info', 'test', 'fresh')").bind(
        freshIso,
      ),
      env.DB.prepare(
        "INSERT INTO push_log (at, policy, title, body, device_count, result) VALUES (?, 'p', 't', 'b', 1, 'ok')",
      ).bind(oldIso),
      env.DB.prepare(
        "INSERT INTO push_log (at, policy, title, body, device_count, result) VALUES (?, 'p', 't', 'b', 1, 'ok')",
      ).bind(freshIso),
      env.DB.prepare("INSERT INTO pair_codes (code_hash, expires_at, created_by) VALUES ('expired-hash', ?, 'owner')").bind(
        oldIso,
      ),
      env.DB.prepare("INSERT INTO pair_codes (code_hash, expires_at, created_by) VALUES ('fresh-hash', ?, 'owner')").bind(
        new Date(NOW.getTime() + 3600_000).toISOString(),
      ),
    ]);

    // housekeeping 定时 03:30，直接把 next_run_at 提前，逼它在这次 tick 到期。
    await runTick(NOW); // 首次运行先播种 jobs 行
    await env.DB.prepare("UPDATE jobs SET next_run_at = ? WHERE name = 'housekeeping'").bind(NOW.toISOString()).run();

    const result = await runTick(NOW);
    expect(result.ran).toContain("housekeeping");

    const logs = await env.DB.prepare("SELECT message FROM logs").all<{ message: string }>();
    expect(logs.results.map((r) => r.message)).toEqual(["fresh"]);

    const pushLogs = await env.DB.prepare("SELECT result FROM push_log").all();
    expect(pushLogs.results.length).toBe(1);

    const pairCodes = await env.DB.prepare("SELECT code_hash FROM pair_codes").all<{ code_hash: string }>();
    expect(pairCodes.results.map((r) => r.code_hash)).toEqual(["fresh-hash"]);
  });
});

// F8：healthcheck 的 ping 必须带超时——没有超时的话，一次挂起的健康检查请求会一直占用
// waitUntil 里的那个 promise（虽然不阻塞 tick() 本身返回，但会让 Worker 实例迟迟不能
// 回收，浪费 CPU 配额）。
describe("T5.6 修复 1：seedJobs 预算", () => {
  it("8 个处理器各 8 次 D1 查询 → 一次 tick 的 prepare 总数 ≤ 45（含首次播种）", async () => {
    resetRegistryForTest();
    for (const name of ALL_JOB_NAMES) {
      registerJob(name, async (e) => {
        for (let i = 0; i < 8; i++) await e.DB.prepare("SELECT 1").first();
      });
    }
    const counted = instrumentD1(env.DB);
    await tick({ ...env, DB: counted.db }, createExecutionContext(), NOW);
    expect(ALL_JOB_NAMES.length).toBe(8);
    expect(counted.count()).toBeLessThanOrEqual(45);
  });

  it("首次 tick 后 jobs 表有 8 行；再次 tick（都已存在）不重复插入、不新增行", async () => {
    resetRegistryForTest();
    for (const name of ALL_JOB_NAMES) {
      registerJob(name, async () => {});
    }
    await runTick(NOW);
    const first = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(first?.n).toBe(8);

    await runTick(new Date(NOW.getTime() + 24 * 3600_000));
    const second = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(second?.n).toBe(8);
  });
});

describe("healthcheck ping 超时保护", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (env as { HEALTHCHECK_URL?: string }).HEALTHCHECK_URL;
  });

  it("配置了 HEALTHCHECK_URL 时，ping 请求带 AbortSignal（不会无限挂起）", async () => {
    (env as { HEALTHCHECK_URL?: string }).HEALTHCHECK_URL = "https://healthcheck.example/ping";
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const ctx = createExecutionContext();
    await tick(env, ctx, NOW);
    await waitOnExecutionContext(ctx);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });
});
