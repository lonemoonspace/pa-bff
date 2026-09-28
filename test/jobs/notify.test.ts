// jobs/notify.ts 的集成测试：CONTRACT.md 6.3 节「至多一次」流程 —— 开关判定、快照/状态读取、
// 四个策略的评估顺序、提交后不回滚不重试、D1/外部请求预算。D1 是真的（vitest-pool-workers），
// FCM/oauth 走 test/helpers/fcm-mock.ts 的 vi.spyOn(globalThis, "fetch")。
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FootballStatusSchema,
  TrafficStatusSchema,
  TrainStatusSchema,
  WeatherStatusSchema,
  type PlanLeg,
} from "../../src/contract/dashboard";
import { DEFAULT_SETTINGS, type Settings } from "../../src/contract/settings";
import { importMasterKey, seal } from "../../src/crypto/secretbox";
import { db } from "../../src/db/client";
import { secrets } from "../../src/db/schema";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import { trainConfigKey } from "../../src/domain/l1-stations";
import { notifyJob } from "../../src/jobs/notify";
import { resetFcmCacheForTest } from "../../src/notify/fcm";
import { readStates } from "../../src/notify/state";
import { registerJob, resetRegistryForTest } from "../../src/scheduler/jobs";
import { tick } from "../../src/scheduler/tick";
import { nextRunAt } from "../../src/scheduler/cadence";
import * as snapshot from "../../src/snapshot/store";
import { instrumentD1 } from "../helpers/d1-counter";
import { makeTestServiceAccount, mockGoogle } from "../helpers/fcm-mock";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM secrets");
  await env.DB.exec("DELETE FROM push_log");
  await env.DB.exec("DELETE FROM notify_state");
  await env.DB.exec("DELETE FROM snapshots");
  resetFcmCacheForTest();
});

afterEach(() => {
  resetFcmCacheForTest();
});

// 2026-09-22 是夏令时（Oslo = UTC+2）。默认 WORK 07:00–10:00 Oslo = 05:00–08:00Z。
const WORK_START_UTC = "2026-09-22T05:00:00.000Z"; // 07:00 Oslo（窗口起点）
const NOW = new Date("2026-09-22T06:00:00.000Z"); // 08:00 Oslo，WORK 窗口内、早已过 10 分钟宽限

// 每个用例都从 DEFAULT_SETTINGS 出发合并 patch（而不是叠加上一个用例留下的设置行），
// 避免不同用例之间的开关互相污染——settings 是单行表，不像 notify_state/snapshots 那样
// 在 beforeEach 里按表清空。
async function applySettings(patch: Partial<Settings>): Promise<void> {
  const before = await getSettingsRecord(env);
  const result = await putSettings(env, before.revision, { ...DEFAULT_SETTINGS, ...patch }, "test-device");
  if (!result.ok) throw new Error("putSettings 失败");
}

let deviceSeq = 0;

async function insertDevice(token = "fake-fcm-token"): Promise<{ id: string }> {
  deviceSeq += 1;
  const id = `dev-${deviceSeq}`;
  const createdAt = new Date(2026, 0, 1, 0, 0, deviceSeq).toISOString();
  const key = await importMasterKey(env.MASTER_KEY);
  const sealed = await seal(key, token, "push_token");
  await env.DB.prepare(
    `INSERT INTO devices (id, name, role, token_hash, push_token_ct, push_token_iv, created_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(id, `device-${deviceSeq}`, "owner", `hash-${deviceSeq}`, sealed.ciphertext, sealed.iv, createdAt, createdAt)
    .run();
  return { id };
}

async function insertFcmSecret(json: string): Promise<void> {
  const key = await importMasterKey(env.MASTER_KEY);
  const sealed = await seal(key, json, "secret:fcm_service_account");
  await db(env)
    .insert(secrets)
    .values({ name: "fcm_service_account", ciphertext: sealed.ciphertext, iv: sealed.iv, hint: "···test", lastTestJson: null, updatedAt: new Date().toISOString() });
}

function leg(overrides: Partial<PlanLeg> = {}): PlanLeg {
  return {
    line: "L1",
    depTime: "2026-09-22T08:05:00+02:00",
    arrTime: "",
    fromName: "Spikkestad",
    toName: "",
    delayMin: 0,
    cancelled: false,
    delayKnown: false,
    ...overrides,
  };
}

function trainStatusData(workLegs: PlanLeg[]): unknown {
  return TrainStatusSchema.parse({ work: { legs: workLegs }, home: { legs: [] } });
}

async function seedTrainSnapshot(workLegs: PlanLeg[], fetchedAt: Date, state: "ok" | "stale" = "ok"): Promise<void> {
  const settings = (await getSettingsRecord(env)).settings;
  const configKey = trainConfigKey(settings);
  if (state === "ok") {
    await snapshot.putSuccess(env, "train", trainStatusData(workLegs), { observedAt: fetchedAt.toISOString(), configKey }, fetchedAt);
  } else {
    await snapshot.putFailure(env, "train", { code: "upstream_5xx", message: "boom", at: fetchedAt.toISOString() }, configKey, fetchedAt);
  }
}

async function seedWeatherSnapshot(fetchedAt: Date): Promise<void> {
  const data = WeatherStatusSchema.parse({ temperature: 5, symbolCode: "clearsky_day" });
  await snapshot.putSuccess(env, "weather", data, { observedAt: fetchedAt.toISOString(), configKey: "origin" }, fetchedAt);
}

async function seedTrafficSnapshot(fetchedAt: Date): Promise<void> {
  const data = TrafficStatusSchema.parse({ durationSec: 600 });
  await snapshot.putSuccess(env, "traffic_outbound", data, { observedAt: fetchedAt.toISOString(), configKey: "origin|dest" }, fetchedAt);
}

async function seedIdleTrafficSnapshot(fetchedAt: Date): Promise<void> {
  // 昨天的 idle 快照：state=idle（无效输入），但快照存在且非 not_configured，属于「应有」来源。
  await snapshot.putState(env, "traffic_outbound", "idle", "origin|dest", fetchedAt);
}

async function seedFootballFinished(idEvent: string, fetchedAt: Date): Promise<void> {
  const data = FootballStatusSchema.parse({
    lastMatches: [
      {
        idEvent,
        homeTeam: "Real Madrid",
        awayTeam: "Inter Milan",
        homeScore: 2,
        awayScore: 1,
        status: "FINISHED",
        league: "UEFA Champions League",
      },
    ],
  });
  await snapshot.putSuccess(env, "football", data, { observedAt: fetchedAt.toISOString(), configKey: "86" }, fetchedAt);
}

async function readNotifyStateRow(policy: string): Promise<{ json: string | null; version: number } | undefined> {
  const states = await readStates(env);
  return states.get(policy as never);
}

async function pushLogCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_log").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("notifyJob：开关判定与基本预算", () => {
  it("四个开关全关 → D1 = 1、fetch = 0", async () => {
    const google = mockGoogle();
    const counted = instrumentD1(env.DB);
    await notifyJob({ ...env, DB: counted.db }, NOW, new AbortController().signal);
    expect(counted.count()).toBe(1);
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
  });

  it("有开关但无状态变化 → D1 = 3、fetch = 0", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    const google = mockGoogle();
    const counted = instrumentD1(env.DB);
    await notifyJob({ ...env, DB: counted.db }, NOW, new AbortController().signal);
    expect(counted.count()).toBe(3);
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
  });
});

describe("notifyJob：commute_disruption", () => {
  it("WORK 窗口 train 快照含取消腿 → 发送、状态写入指纹；重复运行不重发；恢复后指纹清空且不发送", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();

    await seedTrainSnapshot([leg({ cancelled: true })], new Date(NOW.getTime() - 60_000));
    await notifyJob(env, NOW, new AbortController().signal);

    expect(google.oauthCalls).toHaveLength(1);
    expect(google.fcmCalls).toHaveLength(1);
    const body = JSON.parse(google.fcmCalls[0]?.bodyText ?? "{}") as { message: { data: Record<string, string> } };
    expect(body.message.data.channelId).toBe("commute_disruption");
    expect(body.message.data.deepLink).toBe("personalassistant://home");
    expect(body.message.data.title).toBe("上班列车异常");
    expect(body.message.data.body).toBe("L1 08:05 已取消");

    const state1 = await readNotifyStateRow("commute_disruption");
    expect(state1?.json).toBe('{"fingerprint":"2026-09-22#L1#Spikkestad#true#-1"}');

    // 同一 now、同一快照再跑一次：指纹不变，不应该再发一次。
    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(1);

    // 异常恢复：不再有异常腿。
    await seedTrainSnapshot([leg({ cancelled: false, delayKnown: true, delayMin: 0 })], NOW);
    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(1); // 没有新发送
    const state2 = await readNotifyStateRow("commute_disruption");
    expect(state2?.json).toBe('{"fingerprint":null}');
  });

  it("train 快照 stale → 不评估，notify_state 无该行", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    await seedTrainSnapshot([leg({ cancelled: true })], NOW, "stale");
    const google = mockGoogle();

    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(0);
    const state = await readNotifyStateRow("commute_disruption");
    expect(state).toEqual({ json: null, version: 0 });
  });
});

describe("notifyJob：morning_brief", () => {
  it("07:00（宽限内）traffic 为昨天的 idle 快照 → 不发、状态不变", async () => {
    const graceNow = new Date(WORK_START_UTC);
    await applySettings({ notifyMorningBrief: true });
    await seedTrainSnapshot([leg()], new Date(graceNow.getTime() - 60_000));
    await seedWeatherSnapshot(new Date(graceNow.getTime() - 60_000));
    await seedIdleTrafficSnapshot(new Date(graceNow.getTime() - 24 * 3600_000));
    const google = mockGoogle();

    await notifyJob(env, graceNow, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(0);
    const state = await readNotifyStateRow("morning_brief");
    expect(state).toEqual({ json: null, version: 0 });
  });

  it("07:10（宽限外）→ 发送「... · 暂无数据」，lastSentDate = 今天；同日 07:12 不再重发", async () => {
    const after10 = new Date(new Date(WORK_START_UTC).getTime() + 10 * 60_000);
    await applySettings({ notifyMorningBrief: true, originAddress: "Origin", destinationAddress: "Dest" });
    await seedTrainSnapshot([leg()], new Date(after10.getTime() - 60_000));
    await seedWeatherSnapshot(new Date(after10.getTime() - 60_000));
    await seedIdleTrafficSnapshot(new Date(after10.getTime() - 24 * 3600_000));

    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();

    await notifyJob(env, after10, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(1);
    const body = JSON.parse(google.fcmCalls[0]?.bodyText ?? "{}") as { message: { data: Record<string, string> } };
    expect(body.message.data.title).toBe("早间简报");
    expect(body.message.data.body?.endsWith("暂无数据")).toBe(true);

    const state = await readNotifyStateRow("morning_brief");
    expect(state?.json).toBe(`{"lastSentDate":"2026-09-22"}`);

    const sameDayLater = new Date(after10.getTime() + 2 * 60_000); // 07:12
    await notifyJob(env, sameDayLater, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(1); // 没有新发送
  });
});

describe("notifyJob：football", () => {
  it("终场快照 → notificationKey football:<id>、deepLink football", async () => {
    await applySettings({ notifyFootballMatch: true });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await seedFootballFinished("m-1", new Date(NOW.getTime() - 60_000));
    const google = mockGoogle();

    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(1);
    const body = JSON.parse(google.fcmCalls[0]?.bodyText ?? "{}") as { message: { data: Record<string, string> } };
    expect(body.message.data.notificationKey).toBe("football:m-1");
    expect(body.message.data.deepLink).toBe("personalassistant://football");
  });

  it("开关关 → 不评估，即使快照有效，状态行不存在", async () => {
    await applySettings({ notifyCommuteDisruption: true, notifyFootballMatch: false });
    await seedFootballFinished("m-2", new Date(NOW.getTime() - 60_000));
    const google = mockGoogle();

    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(0);
    const state = await readNotifyStateRow("football");
    expect(state).toEqual({ json: null, version: 0 });
  });
});

describe("notifyJob：ticket", () => {
  const ticketNow = new Date("2026-09-22T10:00:00.000Z"); // 12:00 Oslo，在 [8,21) 内

  it("两张票同时到期 → 两条通知、两条 push_log", async () => {
    await applySettings({
      notifyTicketExpiry: true,
      transitPassUntil: "2026-09-22T23:59",
      parkingPassUntil: "2026-09-22T23:59",
    });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();

    await notifyJob(env, ticketNow, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(2);
    expect(await pushLogCount()).toBe(2);
  });

  it("只清理旧 key（无通知）时状态更新但 0 次 fetch", async () => {
    await applySettings({ notifyTicketExpiry: true, transitPassUntil: "", parkingPassUntil: "" });
    await env.DB.prepare("INSERT INTO notify_state (policy, state_json, version) VALUES (?, ?, 1)")
      .bind("ticket", '{"keys":["TRANSIT:2020-01-01T23:59:soon"]}')
      .run();
    const google = mockGoogle();

    await notifyJob(env, ticketNow, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(0);
    const state = await readNotifyStateRow("ticket");
    expect(state?.json).toBe('{"keys":[]}');
  });
});

describe("notifyJob：至多一次与失败语义", () => {
  it("提交前被并发抢先（version 已变）→ 0 次 FCM、无 push_log 行", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await seedTrainSnapshot([leg({ cancelled: true })], new Date(NOW.getTime() - 60_000));
    const google = mockGoogle();

    const counted = instrumentD1(env.DB, {
      onPrepare: async (sql) => {
        if (sql.startsWith("INSERT INTO notify_state")) {
          // 模拟另一个执行抢先提交了同一策略（version 0 -> 1），让本次条件 upsert 落空。
          await env.DB.prepare(
            "INSERT INTO notify_state (policy, state_json, version) VALUES ('commute_disruption', '{\"fingerprint\":\"other\"}', 1)",
          ).run();
        }
      },
    });

    await notifyJob({ ...env, DB: counted.db }, NOW, new AbortController().signal);
    expect(google.fcmCalls).toHaveLength(0);
    expect(await pushLogCount()).toBe(0);
  });

  it("FCM 503 → push_log failed，状态已提交，notifyJob resolve；下一分钟不重发", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    await seedTrainSnapshot([leg({ cancelled: true })], new Date(NOW.getTime() - 60_000));
    mockGoogle({ fcm: () => new Response("boom", { status: 503 }) });

    await expect(notifyJob(env, NOW, new AbortController().signal)).resolves.toBeUndefined();
    const row = await env.DB.prepare("SELECT result FROM push_log ORDER BY id DESC LIMIT 1").first<{ result: string }>();
    expect(JSON.parse(row?.result ?? "{}")).toMatchObject({ status: "failed" });
    const state = await readNotifyStateRow("commute_disruption");
    expect(state?.json).not.toBeNull();

    const google2 = mockGoogle({ fcm: () => new Response("boom", { status: 503 }) });
    const later = new Date(NOW.getTime() + 60_000);
    await seedTrainSnapshot([leg({ cancelled: true })], new Date(later.getTime() - 60_000));
    await notifyJob(env, later, new AbortController().signal);
    expect(google2.fcmCalls).toHaveLength(0); // 指纹没变，不重发
  });

  it("无设备/无服务账号 → 状态照常提交，push_log skipped，0 次外部请求", async () => {
    await applySettings({ notifyCommuteDisruption: true });
    await seedTrainSnapshot([leg({ cancelled: true })], new Date(NOW.getTime() - 60_000));
    const google = mockGoogle();

    await notifyJob(env, NOW, new AbortController().signal);
    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
    const state = await readNotifyStateRow("commute_disruption");
    expect(state?.json).not.toBeNull();
    const row = await env.DB.prepare("SELECT result FROM push_log ORDER BY id DESC LIMIT 1").first<{ result: string }>();
    expect(JSON.parse(row?.result ?? "{}")).toMatchObject({ status: "skipped", reason: "no_devices" });
  });
});

describe("notifyJob：通过 tick() 运行", () => {
  beforeEach(async () => {
    resetRegistryForTest();
    registerJob("notify", notifyJob);
    await env.DB.exec("DELETE FROM jobs");
    await env.DB.exec("DELETE FROM meta");
  });

  it("jobs 表里 notify 的 last_status = 'ok'、next_run_at = now + 1 分钟", async () => {
    const ctx = createExecutionContext();
    await tick(env, ctx, NOW);
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare("SELECT last_status, next_run_at FROM jobs WHERE name = 'notify'").first<{
      last_status: string;
      next_run_at: string;
    }>();
    expect(row?.last_status).toBe("ok");
    expect(row?.next_run_at).toBe(nextRunAt("notify", NOW, DEFAULT_SETTINGS).toISOString());
  });
});

describe("notifyJob：最坏预算", () => {
  it("四类同时触发、2 台设备、1 台 unregistered → D1 ≤ 8、fetch ≤ 11", async () => {
    await applySettings({
      notifyCommuteDisruption: true,
      notifyMorningBrief: true,
      notifyFootballMatch: true,
      notifyTicketExpiry: true,
      originAddress: "Origin",
      destinationAddress: "Dest",
      transitPassUntil: "2026-09-22T23:59",
      parkingPassUntil: "2026-09-22T23:59",
    });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    const a = await insertDevice("token-a");
    void a;
    const bToken = "token-b";
    await insertDevice(bToken);

    await seedTrainSnapshot([leg({ cancelled: true })], new Date(NOW.getTime() - 60_000));
    await seedWeatherSnapshot(new Date(NOW.getTime() - 60_000));
    await seedTrafficSnapshot(new Date(NOW.getTime() - 60_000));
    await seedFootballFinished("m-budget", new Date(NOW.getTime() - 60_000));

    const google = mockGoogle({
      fcm: (req) => {
        const parsed = JSON.parse(req.bodyText) as { message: { token: string } };
        if (parsed.message.token === bToken) {
          return new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), { status: 400 });
        }
        return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
      },
    });

    const counted = instrumentD1(env.DB);
    await notifyJob({ ...env, DB: counted.db }, NOW, new AbortController().signal);

    expect(counted.count()).toBeLessThanOrEqual(8);
    expect(google.oauthCalls.length + google.fcmCalls.length).toBeLessThanOrEqual(11);
  });
});

describe("T5.6 修复 4：提交后的截止时间", () => {
  it("处理器开始后 55 秒才提交（注入的开始时刻）→ deliver 收到已中止信号，全部记 aborted，处理器 resolve", async () => {
    const ticketNow = new Date("2026-09-22T10:00:00.000Z");
    await applySettings({
      notifyTicketExpiry: true,
      transitPassUntil: "2026-09-22T23:59",
      parkingPassUntil: "2026-09-22T23:59",
    });
    const sa = await makeTestServiceAccount();
    await insertFcmSecret(sa.json);
    await insertDevice();
    const google = mockGoogle();

    // 不真的等 55 秒：直接注入一个「55 秒前」的开始时刻（真实墙钟），
    // 让 notifyJob 内部算出的剩余时间 <= 0，从而立刻用一个已中止的信号调用 deliver。
    const startedAt = new Date(Date.now() - 55_000);
    await expect(
      notifyJob(env, ticketNow, new AbortController().signal, startedAt),
    ).resolves.toBeUndefined();

    expect(google.oauthCalls).toHaveLength(0);
    expect(google.fcmCalls).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT result FROM push_log ORDER BY id").all<{ result: string }>();
    expect(rows.results.length).toBe(2); // 两张票同时到期，仍写了两条 push_log
    for (const row of rows.results) {
      const result = JSON.parse(row.result) as { status: string; reason: string | null };
      expect(result).toMatchObject({ status: "skipped", reason: "aborted" });
    }
  });
});
