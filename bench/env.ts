// 基准脚本用的 Env 构造与数据播种。只把 D1 换成 fake-d1.ts 的内存 SQLite；密钥仍走真实
// 的 secretbox（crypto.subtle 是 Node 的真实实现，不是替身），保证「解密开销」也计入基准。
import { seal, importMasterKey } from "../src/crypto/secretbox";
import type { Env } from "../src/env";
import { FakeD1Database } from "./fake-d1";

// 与 vitest.config.ts 里测试专用的主密钥一致（不是真实机密）。
export const BENCH_MASTER_KEY = "iN/Gcnuuu887bqnQ9I/yOgc1ZByf+qkaVUaPe4mYOzY=";

export function createBenchEnv(): { env: Env; db: FakeD1Database } {
  const db = new FakeD1Database();
  const env = {
    MASTER_KEY: BENCH_MASTER_KEY,
    DB: db as unknown as Env["DB"],
    ASSETS: undefined as unknown as Env["ASSETS"],
  } as Env;
  return { env, db };
}

/** 覆盖 settings 表唯一一行的 json 字段（不经过乐观锁，基准脚本内部用，绕开版本号）。 */
export function seedSettings(db: FakeD1Database, patch: Record<string, unknown>): void {
  const row = db.raw.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string } | undefined;
  const current = row ? (JSON.parse(row.json) as Record<string, unknown>) : {};
  const next = { ...current, ...patch };
  db.raw.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(next));
}

/** 写入一个密钥（真实加密），供 traffic / football 任务的 getSecretPlain 用。 */
export async function seedSecret(db: FakeD1Database, name: string, value: string): Promise<void> {
  const key = await importMasterKey(BENCH_MASTER_KEY);
  const sealed = await seal(key, value, `secret:${name}`);
  db.raw
    .prepare(
      "INSERT INTO secrets (name, ciphertext, iv, hint, last_test_json, updated_at) VALUES (?, ?, ?, '···test', NULL, ?) " +
        "ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at",
    )
    .run(name, sealed.ciphertext, sealed.iv, new Date().toISOString());
}

/** 清空令牌桶，供 football 基准每次迭代前重置，避免真跑几次就把桶掏空导致后续迭代走「令牌不足」分支。 */
export function resetRateBuckets(db: FakeD1Database): void {
  db.exec("DELETE FROM rate_buckets");
}
