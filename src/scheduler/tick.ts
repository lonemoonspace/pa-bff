// 调度器主循环。Cron 每分钟触发一次，按 CONTRACT.md 第 5 节 1–8 步执行（G3 审查修订版）：
// 1) 首次运行时为所有已注册任务播种 jobs 行；2) 挑出到期且租约已过期的任务（最多 4 个）；
// 3) 逐个用一条 UPDATE 同时抢租约、预扣一次失败（崩溃安全）；4) 处理器超时 60 秒；
// 5) 成功清零、失败保留预扣结果，写回都以「租约=本次抢到的值」为条件，防止被接管后覆盖；
// 6) 每个任务单独 try/catch，写回失败不影响后续任务；7) last_tick_at 在 finally 写；
// 8) 设置解析失败回退到 DEFAULT_SETTINGS。
import { getSettings } from "../config/store";
import { DEFAULT_SETTINGS, type Settings } from "../contract/settings";
import type { Env } from "../env";
import { ALL_JOB_NAMES, type CadenceCtx, type JobName, nextRunAt, nextRunAtAfterFailure } from "./cadence";
import { getJobHandler, registeredJobNames } from "./jobs";

const LEASE_MS = 120_000;
const HANDLER_TIMEOUT_MS = 60_000; // 必须小于 LEASE_MS，否则租约可能在处理器还没超时前就被别人抢走
const MAX_TASKS_PER_TICK = 4;

export interface TickResult {
  /** 本次 tick 抢到租约并尝试执行过的任务名（含处理器抛错的）。 */
  ran: string[];
}

function isJobName(name: string): name is JobName {
  return (ALL_JOB_NAMES as readonly string[]).includes(name);
}

/**
 * 首次运行时为所有已注册任务插入 jobs 行（next_run_at=now），已存在的不动。
 * T5.6 修复 1：一条多行 INSERT 只算一次 prepare（原来每个任务名各 prepare 一条，
 * 8 个任务就占掉 8 次 D1 预算，导致最坏情形下单次 tick 总数达到 51、超过第 5 节第
 * 8 步的 45 次上限）。
 */
async function seedJobs(env: Env, names: string[], nowIso: string): Promise<void> {
  if (names.length === 0) return;
  const valuesSql = names.map(() => "(?, ?, 0)").join(", ");
  const binds = names.flatMap((name) => [name, nowIso]);
  await env.DB.prepare(`INSERT INTO jobs (name, next_run_at, fail_count) VALUES ${valuesSql} ON CONFLICT(name) DO NOTHING`)
    .bind(...binds)
    .run();
}

interface DueRow {
  name: string;
  fail_count: number | null;
}

/** 挑出到期（next_run_at<=now）且租约已过期（或没租约）的任务，按 next_run_at 升序最多 4 个。 */
async function pickDueJobs(env: Env, nowIso: string): Promise<DueRow[]> {
  const rows = await env.DB.prepare(
    `SELECT name, fail_count FROM jobs
     WHERE next_run_at IS NOT NULL AND next_run_at <= ?1
       AND (lease_until IS NULL OR lease_until < ?1)
     ORDER BY next_run_at ASC
     LIMIT ?2`,
  )
    .bind(nowIso, MAX_TASKS_PER_TICK)
    .all<DueRow>();
  return rows.results;
}

interface Acquired {
  leaseUntilIso: string;
  /** 「假设这次也失败」而预扣之后的 fail_count；成功时会在 finishJobSuccess 里清零。 */
  prefailFailCount: number;
}

/**
 * 抢租约 + 预扣失败（G3 修复 1/2/3）：一条 UPDATE 同时做三件事——
 *   1) 抢占租约时重新核对 `next_run_at <= now`：只信 pickDueJobs 那一刻的快照不够，
 *      因为同一次 tick 里前面的任务可能耗时很久，真正抢占这一个任务时 next_run_at
 *      早已经被别的执行（甚至是同一次 tick 里更早抢到过它、又失败退避过）推到未来；
 *   2) fail_count+1、next_run_at 推到「假设这次也失败」的退避时刻——这样即使 Worker
 *      在处理器执行期间被杀，失败次数与退避也已经落库，不会停在原地反复被选中；
 *   3) 额外用 `fail_count = ?`（pickDueJobs 读到的旧值）做乐观锁，防止这之间 fail_count
 *      已经被别的执行改过而不自知。
 * 影响的行数用 D1Result.meta.changes 判断（不是 SQL 的 changes() 函数，BRIEF 里说明过
 * 可以放心这样用）：不是 1 就说明没抢到，调用方直接跳过。
 */
async function acquireLease(
  env: Env,
  name: string,
  prevFailCount: number,
  now: Date,
  settings: Settings,
): Promise<Acquired | null> {
  const nowIso = now.toISOString();
  const leaseUntilIso = new Date(now.getTime() + LEASE_MS).toISOString();
  const prefailFailCount = prevFailCount + 1;
  const jobName = isJobName(name) ? name : null;
  // 未知任务名理论上不会发生（只有 registerJob 注册过的名字才会被播种进 jobs 表）；
  // 给个保守兜底避免整个 tick 崩掉，测试里用到的临时任务名会走这条分支。
  const prefailNextRunAt = jobName
    ? nextRunAtAfterFailure(jobName, now, settings, prefailFailCount)
    : new Date(now.getTime() + 30 * 60_000);

  const result = await env.DB.prepare(
    `UPDATE jobs
     SET lease_until = ?, last_status = 'running', fail_count = ?, next_run_at = ?
     WHERE name = ? AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) AND fail_count = ?`,
  )
    .bind(leaseUntilIso, prefailFailCount, prefailNextRunAt.toISOString(), name, nowIso, nowIso, prevFailCount)
    .run();

  if (result.meta.changes !== 1) return null;
  return { leaseUntilIso, prefailFailCount };
}

/** 成功写回：fail_count 清零，next_run_at 按正常间隔计算（可用处理器返回的 CadenceCtx）。 */
async function finishJobSuccess(
  env: Env,
  name: string,
  now: Date,
  settings: Settings,
  leaseUntilIso: string,
  durationMs: number,
  cadenceCtx: CadenceCtx,
): Promise<void> {
  const jobName = isJobName(name) ? name : null;
  const next = jobName ? nextRunAt(jobName, now, settings, cadenceCtx) : new Date(now.getTime() + 30 * 60_000);

  // 条件里的 `lease_until = ?`（G3 修复 2）：值必须是这次执行自己抢到的那个，
  // 影响 0 行说明租约已经被另一次执行接管，这次的结果作废，只记日志，不覆盖接管者的状态。
  const result = await env.DB.prepare(
    `UPDATE jobs
     SET lease_until = NULL, next_run_at = ?, fail_count = 0, last_run_at = ?, last_status = 'ok', last_duration_ms = ?
     WHERE name = ? AND lease_until = ?`,
  )
    .bind(next.toISOString(), now.toISOString(), durationMs, name, leaseUntilIso)
    .run();

  if (result.meta.changes !== 1) {
    console.warn(`任务 ${name} 完成时租约已被接管，放弃写回成功结果`);
  }
}

/** 失败写回：保留第 2 步预扣的 fail_count / next_run_at，只更新 last_status / last_duration_ms。 */
async function finishJobFailure(env: Env, name: string, now: Date, leaseUntilIso: string, durationMs: number): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE jobs
     SET lease_until = NULL, last_run_at = ?, last_status = 'error', last_duration_ms = ?
     WHERE name = ? AND lease_until = ?`,
  )
    .bind(now.toISOString(), durationMs, name, leaseUntilIso)
    .run();

  if (result.meta.changes !== 1) {
    console.warn(`任务 ${name} 失败写回时租约已被接管，放弃写回`);
  }
}

/** 成功或失败都要写 meta.last_tick_at，供 /healthz 与管理界面读。 */
async function writeLastTickAt(env: Env, nowIso: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_tick_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(nowIso)
    .run();
}

/**
 * 设置解析失败时回退到 DEFAULT_SETTINGS 并写一条 logs（G3 修复 7），不让整个 tick 停摆。
 * 导出供 P3 各任务处理器复用（见 bff/TASKS.md「P3 通用约定」），本卡（T3.3）是第一个
 * 需要它的调用方，按约定只加这一处 export，不改函数本身的行为。
 */
export async function loadSettingsOrFallback(env: Env, nowIso: string): Promise<Settings> {
  try {
    return await getSettings(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("settings 解析失败，回退到 DEFAULT_SETTINGS", err);
    await env.DB.prepare("INSERT INTO logs (at, level, source, message) VALUES (?, 'error', 'scheduler', ?)")
      .bind(nowIso, `settings 解析失败，已回退到默认设置：${message}`)
      .run();
    return DEFAULT_SETTINGS;
  }
}

/** 处理器超时保护（G3 修复 2）：60 秒必须小于租约的 120 秒，超时后当作失败处理，不会让 tick 卡死。 */
function withTimeout(promise: Promise<CadenceCtx | void>, ms: number): Promise<CadenceCtx | void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`任务超时（超过 ${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 调度器主入口。`now` 一律通过参数注入（测试用固定时刻），不在函数体内读系统时钟。
 * `ctx` 用于 HEALTHCHECK_URL 配置时的 ping（不阻塞 tick 本身的返回）。
 */
export async function tick(env: Env, ctx: ExecutionContext, now: Date = new Date()): Promise<TickResult> {
  const nowIso = now.toISOString();

  await seedJobs(env, registeredJobNames(), nowIso);

  const settings = await loadSettingsOrFallback(env, nowIso);
  const due = await pickDueJobs(env, nowIso);

  const ran: string[] = [];
  try {
    for (const row of due) {
      // 每个任务单独 try/catch（G3 修复 3/6）：抢租约、执行、写回任何一步出错，
      // 都不该连累后面还没处理的任务。
      try {
        const acquired = await acquireLease(env, row.name, row.fail_count ?? 0, now, settings);
        if (!acquired) continue; // 被并发的另一次 tick 抢先，或状态已变，跳过

        const handler = getJobHandler(row.name);
        const signal = AbortSignal.timeout(HANDLER_TIMEOUT_MS);
        const startedAt = Date.now();
        let ok = true;
        let cadenceCtx: CadenceCtx = {};
        if (handler) {
          try {
            const result = await withTimeout(handler(env, now, signal), HANDLER_TIMEOUT_MS);
            if (result) cadenceCtx = result;
          } catch (err) {
            ok = false;
            console.error(`任务 ${row.name} 执行失败`, err);
          }
        }
        const durationMs = Date.now() - startedAt;

        try {
          if (ok) {
            await finishJobSuccess(env, row.name, now, settings, acquired.leaseUntilIso, durationMs, cadenceCtx);
          } else {
            await finishJobFailure(env, row.name, now, acquired.leaseUntilIso, durationMs);
          }
        } catch (err) {
          // 写回本身失败：不让这一个任务的异常影响后面的任务（last_tick_at 仍在 finally 写）。
          console.error(`任务 ${row.name} 写回失败`, err);
        }
        ran.push(row.name);
      } catch (err) {
        console.error(`任务 ${row.name} 处理失败`, err);
      }
    }
  } finally {
    await writeLastTickAt(env, nowIso);
  }

  if (env.HEALTHCHECK_URL) {
    const url = env.HEALTHCHECK_URL;
    // F8：ping 请求必须带超时——没有超时的话，一次挂起的请求会一直占着 waitUntil 里的
    // 这个 promise，让 Worker 实例迟迟不能回收。
    ctx.waitUntil(fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => {}));
  }

  return { ran };
}
