// 令牌桶限流：football-data.org 免费计划限 10 次/分钟，用 rate_buckets 表记录剩余令牌。
// 用单条 INSERT ... ON CONFLICT ... RETURNING 原子扣减一个令牌，避免「读令牌数 -> 判断 ->
// 写回」三步之间的竞态（D1 在同一 isolate 内可能有多个并发的异步调用交叉执行）。
//
// 补充规则：令牌按经过时间线性补充到容量上限；补充与扣减在同一条 SQL 语句里完成，
// 补充只依赖 (当前时刻 - 上次更新时刻) 与固定速率，不需要额外查询。
import type { Env } from "../env";

/** 桶容量：与 football-data.org 免费计划的 10 次/分钟对齐。 */
export const BUCKET_CAPACITY = 10;
/** 每分钟补满一整桶，换算成「每秒补充的令牌数」——SQL 里用 unixepoch() 算经过秒数。 */
const REFILL_TOKENS_PER_SEC = BUCKET_CAPACITY / 60;

/**
 * 尝试从名为 [name] 的令牌桶中扣减一个令牌。
 * 返回 true 表示扣减成功（本次可以发请求）；false 表示令牌不足（不应发请求）。
 *
 * 实现：INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING 是单条原子语句——
 * - 桶不存在（首次调用）：INSERT 直接写入「满桶 - 1」，一定成功；
 * - 桶已存在：ON CONFLICT 分支按 (now - updated_at) 补充令牌后封顶容量，再扣 1；
 *   DO UPDATE 的 WHERE 子句复用同一个表达式判断补充后是否够扣（>= 0，留一点浮点误差余量），
 *   不够时 WHERE 为假，SQLite 视为「什么都不做」，RETURNING 不产生行，据此判断本次失败。
 */
export async function takeToken(env: Env, name: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO rate_buckets (name, tokens, updated_at)
     VALUES (?1, ?2 - 1, ?3)
     ON CONFLICT(name) DO UPDATE SET
       tokens = MIN(?2, rate_buckets.tokens + (unixepoch(?3) - unixepoch(rate_buckets.updated_at)) * ?4) - 1,
       updated_at = ?3
     WHERE MIN(?2, rate_buckets.tokens + (unixepoch(?3) - unixepoch(rate_buckets.updated_at)) * ?4) - 1 >= -0.0000001
     RETURNING tokens`,
  )
    .bind(name, BUCKET_CAPACITY, nowIso, REFILL_TOKENS_PER_SEC)
    .first<{ tokens: number }>();
  return row !== null;
}
