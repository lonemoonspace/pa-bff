// notify_state 表的读写：读全部四个策略的当前状态与版本号，以及 CONTRACT.md 6.3 节的
// 「一条条件 upsert，只有 RETURNING 里出现的策略才发送」。
import { NotifyPolicySchema, type NotifyPolicy } from "../contract/push";
import type { Env } from "../env";

export interface NotifyStateRow {
  json: string | null;
  version: number;
}

const ALL_POLICIES = NotifyPolicySchema.options;

/** 读全部策略当前状态（1 次查询）；缺行的策略回退 { json: null, version: 0 }。 */
export async function readStates(env: Env): Promise<Map<NotifyPolicy, NotifyStateRow>> {
  const result = new Map<NotifyPolicy, NotifyStateRow>();
  for (const policy of ALL_POLICIES) result.set(policy, { json: null, version: 0 });

  const { results } = await env.DB.prepare("SELECT policy, state_json, version FROM notify_state").all<{
    policy: string;
    state_json: string | null;
    version: number | null;
  }>();

  for (const row of results) {
    if (!(ALL_POLICIES as readonly string[]).includes(row.policy)) continue;
    result.set(row.policy as NotifyPolicy, { json: row.state_json, version: row.version ?? 0 });
  }
  return result;
}

export interface NotifyStateChange {
  policy: NotifyPolicy;
  json: string;
  /** 提交前读到的 version（缺行按 0），用于条件 upsert 的乐观锁。 */
  expectedVersion: number;
}

/**
 * 用一条条件 upsert 提交所有变化的状态（CONTRACT.md 6.3 节第 3 步）：
 *
 *   INSERT INTO notify_state (policy, state_json, version) VALUES (?, ?, 1), ...
 *   ON CONFLICT(policy) DO UPDATE SET state_json = excluded.state_json,
 *     version = notify_state.version + 1
 *   WHERE COALESCE(notify_state.version, 0) = CASE notify_state.policy WHEN ? THEN ? ... END
 *   RETURNING policy
 *
 * 只有 RETURNING 里出现的策略说明这次提交生效（没被别的执行抢先），调用方只应该发送
 * 这些策略对应的通知。changes 为空时不发任何查询。
 */
export async function commitStates(env: Env, changes: NotifyStateChange[]): Promise<Set<NotifyPolicy>> {
  if (changes.length === 0) return new Set();

  const valuesSql = changes.map(() => "(?, ?, 1)").join(", ");
  const caseSql = changes.map(() => "WHEN ? THEN ?").join(" ");

  const sql = `INSERT INTO notify_state (policy, state_json, version) VALUES ${valuesSql}
    ON CONFLICT(policy) DO UPDATE SET state_json = excluded.state_json, version = notify_state.version + 1
    WHERE COALESCE(notify_state.version, 0) = CASE notify_state.policy ${caseSql} ELSE -1 END
    RETURNING policy`;

  const binds: unknown[] = [];
  for (const c of changes) binds.push(c.policy, c.json);
  for (const c of changes) binds.push(c.policy, c.expectedVersion);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ policy: string }>();

  return new Set(results.map((r) => r.policy as NotifyPolicy));
}
