// GET /admin/api/overview 与 POST /admin/api/jobs/:name/run 的集成测试。
// 用本地开发旁路（ADMIN_DEV_BYPASS=1 + localhost）跳过 Access JWT 签发的麻烦——
// T7.1 已经把该旁路本身测过了，这里只关心总览接口自己的逻辑。
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import type { Env } from "../../src/env";
import { getSettingsRecord, putSettings } from "../../src/config/store";
import { configKeysFor } from "../../src/snapshot/config-keys";
import * as snapshot from "../../src/snapshot/store";
import { putSecret } from "../../src/secrets/store";
import { instrumentD1 } from "../helpers/d1-counter";
import { DEFAULT_SETTINGS } from "../../src/contract/settings";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM meta");
  await env.DB.exec("DELETE FROM pair_codes");
  await env.DB.exec("DELETE FROM snapshots");
  await env.DB.exec("DELETE FROM jobs");
  await env.DB.exec("DELETE FROM secrets");
  await env.DB.exec("UPDATE settings SET json = NULL, revision = NULL, updated_at = NULL, updated_by = NULL WHERE id = 1");
});

afterEach(() => {
  // instrumentD1 不改动真实 env.DB，无需清理。
});

function adminEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
    ACCESS_AUD: "test-aud-tag",
    ADMIN_DEV_BYPASS: "1",
    ...overrides,
  } as unknown as Env;
}

function get(path: string, testEnv: Env) {
  return app.request(`http://localhost${path}`, {}, testEnv);
}

function post(path: string, testEnv: Env, headers: Record<string, string> = { "X-PA-Admin": "1", Origin: "http://localhost" }) {
  return app.request(`http://localhost${path}`, { method: "POST", headers }, testEnv);
}

interface OverviewBody {
  now: string;
  lastTickAt: string | null;
  claimedAt: string | null;
  settings: { revision: number; updatedAt: string | null; updatedBy: string | null };
  devices: { total: number; owners: number; withPushToken: number };
  jobs: Array<{ name: string; failCount: number; nextRunAt: string | null }>;
  sources: Array<{ source: string; state: string | null; configMatches: boolean }>;
  secrets: Array<{ name: string; state: string; hint: string | null }>;
}

const SOURCE_NAMES = ["weather", "train", "traffic_outbound", "traffic_return", "bus", "football"];

describe("GET /admin/api/overview", () => {
  it("空库（刚迁移）→ 200，六个来源都在且 state: null，D1 次数 ≤ 6", async () => {
    const counted = instrumentD1(env.DB);
    const res = await get("/admin/api/overview", adminEnv({ DB: counted.db }));
    expect(res.status).toBe(200);
    const body = await res.json<OverviewBody>();
    expect(body.sources.map((s) => s.source).sort()).toEqual([...SOURCE_NAMES].sort());
    for (const source of body.sources) {
      expect(source.state).toBeNull();
    }
    expect(counted.count()).toBeLessThanOrEqual(6);
  });

  it("写入 train 快照后改站名 → 该行 configMatches: false；未改则 true", async () => {
    // 空库时 settings 行的 revision 是 NULL；putSettings 的乐观锁靠 WHERE revision = ?
    // 生效，得先把默认设置真正落库（revision=1），下面才能用 putSettings 改一次。
    // [gate] P9：车站默认值为空串（未选择），这里先显式选好一对车站，才能测试
    // 「改站名后 configMatches 变化」——车站没选时 train 的 configKey 恒为 null。
    await env.DB.prepare("UPDATE settings SET json = ?, revision = 1, updated_at = ? WHERE id = 1")
      .bind(JSON.stringify({ ...DEFAULT_SETTINGS, originStation: "Spikkestad", destStation: "Sandvika" }), new Date().toISOString())
      .run();
    const before = await getSettingsRecord(env);
    const keys = configKeysFor(before.settings);
    const now = new Date("2026-09-22T06:00:00.000Z");
    await snapshot.putSuccess(
      env,
      "train",
      {
        work: { planText: "", legs: [], adviceLevel: "UNKNOWN", adviceText: "", alternatives: [], oppositeText: "", oppositeState: "NONE" },
        home: { planText: "", legs: [], adviceLevel: "UNKNOWN", adviceText: "", alternatives: [], oppositeText: "", oppositeState: "NONE" },
        transfer: null,
        updatedAt: "2026-09-22T08:00:00+02:00",
        originStation: "Spikkestad",
        destinationStation: "Sandvika",
      },
      { observedAt: now.toISOString(), configKey: keys.train },
      now,
    );

    const first = await get("/admin/api/overview", adminEnv());
    const firstBody = await first.json<OverviewBody>();
    const trainRowBefore = firstBody.sources.find((s) => s.source === "train");
    expect(trainRowBefore?.configMatches).toBe(true);

    const changed = await putSettings(env, before.revision, { ...before.settings, originStation: "Asker" }, "device-1");
    if (!changed.ok) throw new Error("putSettings 失败");

    const second = await get("/admin/api/overview", adminEnv());
    const secondBody = await second.json<OverviewBody>();
    const trainRowAfter = secondBody.sources.find((s) => s.source === "train");
    expect(trainRowAfter?.configMatches).toBe(false);
  });

  it("jobs 有失败行 → failCount 正确；meta 有 last_tick_at → 原样返回", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (name, next_run_at, fail_count, last_status) VALUES ('train', NULL, 3, 'error')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('last_tick_at', '2026-09-22T06:00:00.000Z')",
    ).run();

    const res = await get("/admin/api/overview", adminEnv());
    const body = await res.json<OverviewBody>();
    const trainJob = body.jobs.find((j) => j.name === "train");
    expect(trainJob?.failCount).toBe(3);
    expect(body.lastTickAt).toBe("2026-09-22T06:00:00.000Z");
  });

  it("响应不含任何密钥明文 / 密文", async () => {
    const SECRET_VALUE = "AIzaSyTest12345";
    const putResult = await putSecret(env, "google_routes", SECRET_VALUE);
    if (!putResult.ok) throw new Error("putSecret 失败");

    const res = await get("/admin/api/overview", adminEnv());
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    const body = JSON.parse(text) as OverviewBody;
    const secretRow = body.secrets.find((s) => s.name === "google_routes");
    expect(secretRow?.state).toBe("present");
  });
});

describe("POST /admin/api/jobs/:name/run", () => {
  it("train → 202 且 next_run_at 设为 now；jobs 无该行时插入", async () => {
    const res = await post("/admin/api/jobs/train/run", adminEnv());
    expect(res.status).toBe(202);
    const body = await res.json<{ queued: string }>();
    expect(body.queued).toBe("train");

    const row = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE name = 'train'").first<{
      next_run_at: string;
    }>();
    expect(row?.next_run_at).toBeTruthy();
    const ageMs = Date.now() - Date.parse(row!.next_run_at);
    expect(Math.abs(ageMs)).toBeLessThan(5000);
  });

  it("housekeeping → 404（不开放手动运行）", async () => {
    const res = await post("/admin/api/jobs/housekeeping/run", adminEnv());
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("未知任务名 → 404", async () => {
    const res = await post("/admin/api/jobs/not_a_job/run", adminEnv());
    expect(res.status).toBe(404);
  });

  it("缺 CSRF 头 → 403", async () => {
    const res = await post("/admin/api/jobs/train/run", adminEnv(), {});
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("csrf_rejected");
  });
});
