import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SettingsSchema } from "../../src/contract/settings";
import { db } from "../../src/db/client";
import { settings } from "../../src/db/schema";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const EXPECTED_TABLES = [
  "meta",
  "settings",
  "secrets",
  "devices",
  "pair_codes",
  "jobs",
  "snapshots",
  "notify_state",
  "push_log",
  "logs",
  "rate_buckets",
];

describe("迁移后的表结构", () => {
  it("11 张表都存在", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name != 'd1_migrations'",
    ).all<{ name: string }>();
    const names = rows.results.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  it("settings 初始行 revision=1 且 json 能被 SettingsSchema 解析", async () => {
    const rows = await db(env).select().from(settings);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(1);
    expect(row.revision).toBe(1);
    const parsed = SettingsSchema.parse(JSON.parse(row.json!));
    // [gate] P9：车站默认值改为空串（未选择），不再回退到具体站名。
    expect(parsed.originStation).toBe("");
    expect(parsed.destStation).toBe("");
  });

  it("settings.id 的 CHECK 约束拒绝 id=2", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO settings (id, json, revision, updated_at, updated_by) VALUES (2, '{}', 1, '2026-01-01T00:00:00.000Z', NULL)",
      ).run(),
    ).rejects.toThrow();
  });
});
