// 任务处理器注册表。tick.ts 只认识注册表里有的任务名：首次运行时为它们在 jobs 表插入行，
// 到期后调用对应 handler。train / bus / weather / traffic_* / football / notify 留给 P3
// 各自的卡去 registerJob；本卡只注册 housekeeping。
import type { Env } from "../env";
import type { CadenceCtx } from "./cadence";

// G3 修复 5：处理器可以返回 CadenceCtx（例如 weather 的 Expires、football 的比赛时刻），
// 交给 tick.ts 在成功写回时传给 nextRunAt 计算下一次间隔；不需要的任务返回 void 即可。
// signal 在 60 秒超时时会被中止（G3 修复 2），数据源类处理器应该把它传给 fetch。
export type JobHandler = (env: Env, now: Date, signal: AbortSignal) => Promise<CadenceCtx | void>;

const registry = new Map<string, JobHandler>();

/** 注册一个任务处理器；同名重复注册会覆盖旧的（主要方便测试）。 */
export function registerJob(name: string, handler: JobHandler): void {
  registry.set(name, handler);
}

export function getJobHandler(name: string): JobHandler | undefined {
  return registry.get(name);
}

/** 当前已注册（因而会被 tick 首次运行播种进 jobs 表）的任务名。 */
export function registeredJobNames(): string[] {
  return [...registry.keys()];
}

/**
 * 仅供测试使用：把注册表重置回「只有 housekeeping」的初始状态。
 * registry 是模块级单例，测试文件里 registerJob 出来的临时任务名（用来验证租约/退避/
 * 4 条上限等行为）会一直留在内存里，不清掉的话会互相污染后面的用例。
 */
export function resetRegistryForTest(): void {
  registry.clear();
  registerJob("housekeeping", housekeeping);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** housekeeping：清理 7 天前的 logs / push_log，以及已过期的配对码。 */
async function housekeeping(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
  const nowIso = now.toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM logs WHERE at IS NOT NULL AND at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM push_log WHERE at IS NOT NULL AND at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM pair_codes WHERE expires_at IS NOT NULL AND expires_at < ?").bind(nowIso),
  ]);
}

registerJob("housekeeping", housekeeping);
