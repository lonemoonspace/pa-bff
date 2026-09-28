// 金标准运行器（TS 端）。与 Kotlin 端的 Golden.kt 读同一批 contracts/golden/*.json，
// 两端逐条比对同一批用例，逐字符对齐 Kotlin 的输出（见 contracts/README.md）。
import { describe, expect, it } from "vitest";
import { z } from "zod";

// cases[].input / expected 的形状因文件而异（由各被测函数决定），这里只校验「外形」：
// 顶层字段齐全、cases 是数组、每条用例有 name/from。具体字段交给调用方的 run() 处理。
const GoldenCaseSchema = z.object({
  name: z.string().min(1),
  from: z.array(z.string()).default([]),
  input: z.unknown(),
  expected: z.unknown(),
});

const GoldenFileSchema = z.object({
  subject: z.string().min(1),
  kotlin: z.string().min(1),
  cases: z.array(GoldenCaseSchema),
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type GoldenFile = z.infer<typeof GoldenFileSchema>;

/**
 * 递归检查 `actual`：JSON 往返（`JSON.parse(JSON.stringify(...))`）会悄悄丢弃或篡改一些值
 * （`undefined` 被删掉或变成数组里的 `null`、`NaN`/`Infinity` 变成 `null`、`bigint` 直接抛出
 * 序列化异常、类实例被拍扁成普通对象），这些情况本该让用例失败，而不是被 JSON 往返「洗白」后
 * 侥幸凑巧等于 `expected`。发现问题时抛出并带上路径，方便定位是输出的哪个字段有问题。
 */
function assertJsonSafe(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(`金标准输出在 ${path} 处是 undefined（JSON 里没有 undefined，只有存在与否）`);
  }
  if (typeof value === "bigint") {
    throw new Error(`金标准输出在 ${path} 处是 bigint，JSON 无法表示`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`金标准输出在 ${path} 处是非有限数（${String(value)}），JSON 无法表示`);
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`金标准输出在 ${path} 处不是普通对象或数组（${String(value)}）`);
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    assertJsonSafe(v, `${path}.${key}`);
  }
}

/**
 * 单条用例的核心断言逻辑，从 [runGolden] 拆出来单独导出：方便 `harness.test.ts` 直接同步调用
 * 并用 `expect(...).toThrow()` 验证「NaN / undefined 数组元素等不安全值必须判失败」，而不必
 * 依赖 vitest 内部把某个 `it()` 故意判为失败又不影响整个测试套件的通过/失败状态。
 */
export function evaluateGoldenCase(input: unknown, expected: unknown, run: (input: unknown) => unknown): void {
  const actual = run(input);
  assertJsonSafe(actual, "$");
  expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
}

/** 断言逻辑与 [evaluateGoldenCase] 共用（先跑、再做同样的 JSON-safe 校验与比较），仅把 run(input) 换成异步版本。 */
export async function evaluateGoldenCaseAsync(
  input: unknown,
  expected: unknown,
  run: (input: unknown) => Promise<unknown>,
): Promise<void> {
  const actual = await run(input);
  assertJsonSafe(actual, "$");
  expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
}

/**
 * 跑一个金标准文件：`describe(subject)` 下每条用例一个 `it(name)`。
 *
 * - 文件没有用例、或用例名重复：直接抛出（同步），整个文件判为无效，而不是把某条用例判失败
 * - 比较在「解析后的结构」层面做（`JSON.parse(JSON.stringify(actual))`），抹掉 `undefined`
 *   与类实例差异，与 Kotlin 端在 `JsonElement` 层面比较对齐；往返前先用 [assertJsonSafe]
 *   排除 `undefined`/非有限数/`bigint`/非普通对象这些「往返后会被悄悄改写」的值
 */
export function runGolden<TInput = unknown>(
  file: unknown,
  run: (input: TInput) => unknown,
): void {
  const parsed = GoldenFileSchema.parse(file);
  if (parsed.cases.length === 0) {
    throw new Error(`金标准文件没有用例：${parsed.subject}`);
  }
  const seen = new Set<string>();
  for (const c of parsed.cases) {
    if (seen.has(c.name)) {
      throw new Error(`金标准文件用例名重复：${parsed.subject} / ${c.name}`);
    }
    seen.add(c.name);
  }

  describe(parsed.subject, () => {
    for (const c of parsed.cases) {
      it(c.name, () => {
        evaluateGoldenCase(c.input, c.expected, run as (input: unknown) => unknown);
      });
    }
  });
}

/**
 * 跑一个金标准文件，`run` 是异步函数：每条用例一个 `it(name, async () => …)`，断言逻辑
 * 与同步版 [runGolden] 共用（见 [evaluateGoldenCaseAsync]）。用于被测函数本身是异步的场景
 * （比如 T4.4 的 `buildTrainStatus`）——不再需要调用方自己用 `beforeAll` + 按对象引用存
 * Map 的方式把异步结果「同步化」，意外调用只让对应那一条用例失败，而不是让整个文件的
 * 其余用例陪葬。
 */
export function runGoldenAsync<TInput = unknown>(
  file: unknown,
  run: (input: TInput) => Promise<unknown>,
): void {
  const parsed = GoldenFileSchema.parse(file);
  if (parsed.cases.length === 0) {
    throw new Error(`金标准文件没有用例：${parsed.subject}`);
  }
  const seen = new Set<string>();
  for (const c of parsed.cases) {
    if (seen.has(c.name)) {
      throw new Error(`金标准文件用例名重复：${parsed.subject} / ${c.name}`);
    }
    seen.add(c.name);
  }

  describe(parsed.subject, () => {
    for (const c of parsed.cases) {
      it(c.name, async () => {
        await evaluateGoldenCaseAsync(c.input, c.expected, run as (input: unknown) => Promise<unknown>);
      });
    }
  });
}
