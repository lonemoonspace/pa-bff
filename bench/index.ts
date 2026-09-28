// CPU 基准入口：`pnpm -C bff bench`。在 Node 里跑（Workers 的 performance.now() 只在
// I/O 时前进，测不出 CPU，见 bff/TASKS.md「P8 通用约定」第 2 条）。
//
// 阈值（同约定第 2/T8.2 条）：单项 p95 ≤ 5ms；「最坏 tick」（一次 tick 最多 4 个任务的 CPU
// 在同一次调用里累加，见调度器 MAX_TASKS_PER_TICK）≤ 8ms（给 Workers 免费版每次调用
// ~10ms CPU 留余量）。CI 机器慢且有噪声时可以设 BFF_BENCH_RELAX=1 把阈值放宽到 1.5 倍，
// 默认不放宽。超出阈值时本脚本只如实报告 + 非零退出，不做任何业务代码改动（留给 G7 决定）。
import { runJobBenches } from "./jobs.bench";
import { runNotifyBench } from "./notify.bench";
import { runColdStartBenches } from "./cold-start.bench";
import { formatTable, type BenchResult } from "./stats";

const RELAX = process.env.BFF_BENCH_RELAX === "1" ? 1.5 : 1;
const PER_ITEM_P95_MS = 5 * RELAX;
const WORST_TICK_MS = 8 * RELAX;
const MAX_TASKS_PER_TICK = 4;

async function main(): Promise<void> {
  const jobResults = await runJobBenches();
  const notifyResult = await runNotifyBench();
  const [fcmResult, accessResult] = await runColdStartBenches();

  const all: BenchResult[] = [...jobResults, notifyResult, fcmResult, accessResult];
  console.log(formatTable(all));
  console.log("");

  let ok = true;
  for (const r of all) {
    if (r.p95Ms > PER_ITEM_P95_MS) {
      ok = false;
      console.log(`[超标] ${r.name}：p95 ${r.p95Ms.toFixed(3)}ms > 阈值 ${PER_ITEM_P95_MS}ms`);
    }
  }

  // 最坏 tick：调度器（scheduler/tick.ts）一次最多跑 MAX_TASKS_PER_TICK 个任务名
  // （train / bus / weather / traffic_outbound / traffic_return / football / notify /
  // housekeeping 共 8 个候选之一，不是「4 个数据任务之外再加 notify」），所以 notify 本身
  // 只占其中一个名额——但 notify 真正发送推送时会带上 FCM 冷启动的开销（getAccessToken），
  // 这里把 notify 的评估耗时与 FCM 冷启动耗时合并成一个候选（notify 最坏情形：评估 + 发一条
  // 需要冷启动令牌的推送），再从全部候选里挑 p95 最重的 4 个求和。
  // housekeeping 未纳入基准（P2 起就是极轻量的占位任务，无外部请求/复杂计算，量级远小于
  // 其它任务，不会进入「最重 4 个」）。
  const notifyWithFcm = {
    name: "notify（评估 + 最坏情形下的 FCM 冷启动发送）",
    medianMs: notifyResult.medianMs + fcmResult.medianMs,
    p95Ms: notifyResult.p95Ms + fcmResult.p95Ms,
    iterations: Math.min(notifyResult.iterations, fcmResult.iterations),
    samples: [],
  };
  const candidates: BenchResult[] = [...jobResults, notifyWithFcm];
  const worstTickComponents = [...candidates].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, MAX_TASKS_PER_TICK);
  const worstTickMs = worstTickComponents.reduce((sum, r) => sum + r.p95Ms, 0);

  console.log("最坏 tick 组成（8 个候选任务名里 p95 最重的 4 个，凑满 MAX_TASKS_PER_TICK）：");
  for (const r of worstTickComponents) {
    console.log(`  + ${r.name}: ${r.p95Ms.toFixed(3)}ms`);
  }
  console.log(`  = 合计 ${worstTickMs.toFixed(3)}ms（阈值 ${WORST_TICK_MS}ms）`);

  if (worstTickMs > WORST_TICK_MS) {
    ok = false;
    console.log(`[超标] 最坏 tick 合计 ${worstTickMs.toFixed(3)}ms > 阈值 ${WORST_TICK_MS}ms`);
  }

  if (!ok) {
    console.log("");
    console.log("存在超标项，按 P8 通用约定不在本卡自行改动业务代码，交由 G7 决定（例如降低单次 tick 的任务数）。");
    process.exitCode = 1;
  } else {
    console.log("");
    console.log("全部基准通过阈值。");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
