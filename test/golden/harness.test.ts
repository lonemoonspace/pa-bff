// harness.ts 自身的测试：用内联的假文件验证「通过 / 格式错误 / 用例名重复」三种情况。
import { describe, expect, it } from "vitest";
import { evaluateGoldenCase, evaluateGoldenCaseAsync, runGolden, runGoldenAsync } from "./harness";

describe("golden harness", () => {
  // 通过：直接调用 runGolden，让它在本文件里注册真正的 describe/it 子用例，全部应当通过。
  runGolden(
    {
      subject: "harness.pass",
      kotlin: "n/a",
      cases: [
        { name: "加一", from: [], input: { n: 1 }, expected: 2 },
        { name: "加二", from: [], input: { n: 2 }, expected: 3 },
      ],
    },
    (input) => (input as { n: number }).n + 1,
  );

  it("文件格式不对（缺 subject）时同步抛出", () => {
    expect(() =>
      runGolden(
        {
          kotlin: "n/a",
          cases: [{ name: "x", from: [], input: {}, expected: 1 }],
        },
        () => 1,
      ),
    ).toThrow();
  });

  it("没有用例时同步抛出", () => {
    expect(() =>
      runGolden({ subject: "harness.empty", kotlin: "n/a", cases: [] }, () => 1),
    ).toThrow(/没有用例/);
  });

  it("run 返回 NaN 时判失败（不能靠 JSON.stringify 把 NaN 拍成 null 侥幸通过）", () => {
    expect(() => evaluateGoldenCase({}, null, () => NaN)).toThrow();
  });

  it("数组元素是 undefined 时判失败（不能靠 JSON.stringify 把它拍成 null 侥幸通过）", () => {
    expect(() => evaluateGoldenCase({}, [null], () => [undefined])).toThrow();
  });

  // T4.6 item 3：runGoldenAsync 的通过路径——直接调用，注册真正的 describe/it 子用例。
  runGoldenAsync(
    {
      subject: "harness.pass-async",
      kotlin: "n/a",
      cases: [
        { name: "异步加一", from: [], input: { n: 1 }, expected: 2 },
        { name: "异步加二", from: [], input: { n: 2 }, expected: 3 },
      ],
    },
    async (input) => (input as { n: number }).n + 1,
  );

  it("runGoldenAsync：run reject 时只有对应那一条用例失败（用 evaluateGoldenCaseAsync 直接验证）", async () => {
    await expect(
      evaluateGoldenCaseAsync({}, 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("runGoldenAsync：没有用例时同步抛出", () => {
    expect(() =>
      runGoldenAsync({ subject: "harness.empty-async", kotlin: "n/a", cases: [] }, async () => 1),
    ).toThrow(/没有用例/);
  });

  it("用例名重复时同步抛出", () => {
    expect(() =>
      runGolden(
        {
          subject: "harness.dup",
          kotlin: "n/a",
          cases: [
            { name: "同名", from: [], input: {}, expected: 1 },
            { name: "同名", from: [], input: {}, expected: 2 },
          ],
        },
        () => 1,
      ),
    ).toThrow(/用例名重复/);
  });
});
