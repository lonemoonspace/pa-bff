// GET /admin/api/logs 的集成测试：分页、level / source 过滤、非法查询参数。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import type { Env } from "../../src/env";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM logs");
});

function adminEnv(): Env {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
    ACCESS_AUD: "test-aud-tag",
    ADMIN_DEV_BYPASS: "1",
  } as unknown as Env;
}

function get(path: string) {
  return app.request(`http://localhost${path}`, {}, adminEnv());
}

async function insertLogs(n: number, opts: { level?: string; source?: string } = {}): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await env.DB.prepare("INSERT INTO logs (at, level, source, message) VALUES (?, ?, ?, ?)")
      .bind(new Date(2026, 0, 1, 0, 0, i).toISOString(), opts.level ?? "info", opts.source ?? "test", `msg-${i}`)
      .run();
  }
}

interface LogsBody {
  entries: Array<{ id: number; at: string; level: string; source: string; message: string }>;
  nextBefore: number | null;
}

describe("GET /admin/api/logs", () => {
  it("75 行 → 第一页 50 条且 nextBefore 有值，第二页 25 条且为 null", async () => {
    await insertLogs(75);
    const first = await get("/admin/api/logs");
    expect(first.status).toBe(200);
    const firstBody = await first.json<LogsBody>();
    expect(firstBody.entries).toHaveLength(50);
    expect(firstBody.nextBefore).not.toBeNull();

    const second = await get(`/admin/api/logs?before=${firstBody.nextBefore}`);
    const secondBody = await second.json<LogsBody>();
    expect(secondBody.entries).toHaveLength(25);
    expect(secondBody.nextBefore).toBeNull();
  });

  it("level 过滤", async () => {
    await insertLogs(3, { level: "info" });
    await insertLogs(2, { level: "error" });
    const res = await get("/admin/api/logs?level=error");
    const body = await res.json<LogsBody>();
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e) => e.level === "error")).toBe(true);
  });

  it("source 过滤", async () => {
    await insertLogs(3, { source: "weather" });
    await insertLogs(2, { source: "bus" });
    const res = await get("/admin/api/logs?source=bus");
    const body = await res.json<LogsBody>();
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e) => e.source === "bus")).toBe(true);
  });

  it("limit=0 → 422", async () => {
    const res = await get("/admin/api/logs?limit=0");
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("invalid_request");
  });

  it("limit=101 → 422", async () => {
    const res = await get("/admin/api/logs?limit=101");
    expect(res.status).toBe(422);
  });

  it("before=abc → 422", async () => {
    const res = await get("/admin/api/logs?before=abc");
    expect(res.status).toBe(422);
  });
});
