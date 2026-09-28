// 统计与计时小工具。CPU 基准要在 Node 里跑（Workers 的 performance.now() 只在 I/O 时前进，
// 测不出 CPU 耗时，见 P8 通用约定第 2 条），所以本文件只依赖 Node 全局的 performance。

export interface BenchResult {
  name: string;
  medianMs: number;
  p95Ms: number;
  iterations: number;
  samples: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function summarize(name: string, samples: number[]): BenchResult {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  return { name, medianMs: median, p95Ms: percentile(sorted, 95), iterations: samples.length, samples: sorted };
}

/**
 * 跑 `iterations` 次，每次先调用 `setup`（不计时——播种数据、重置令牌桶等），
 * 再调用 `run` 并计时。前 `warmup` 次完全丢弃（不计时也不计入 samples），
 * 用来让地理编码缓存、JWKS 缓存等模块级缓存进入「稳态」——这才是调度器里
 * 真实反复执行时的成本，而不是「本 isolate 第一次遇到这个地址」的一次性成本。
 */
export async function bench(
  name: string,
  opts: { iterations?: number; warmup?: number },
  setup: (i: number) => Promise<void> | void,
  run: (i: number) => Promise<void> | void,
): Promise<BenchResult> {
  const iterations = opts.iterations ?? 100;
  const warmup = opts.warmup ?? 3;
  const samples: number[] = [];

  for (let i = 0; i < warmup; i++) {
    await setup(-1 - i);
    await run(-1 - i);
  }

  for (let i = 0; i < iterations; i++) {
    await setup(i);
    const t0 = performance.now();
    await run(i);
    samples.push(performance.now() - t0);
  }

  return summarize(name, samples);
}

export function formatTable(results: BenchResult[]): string {
  const header = ["名称", "中位数 (ms)", "p95 (ms)", "次数"];
  const rows = results.map((r) => [r.name, r.medianMs.toFixed(3), r.p95Ms.toFixed(3), String(r.iterations)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
