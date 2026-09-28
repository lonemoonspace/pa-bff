// domain/{commute-disruption,morning-brief,football-notify}.ts 里没有金标准覆盖的部分：
// 三个新状态的持久化解析回退行为（null / 非法 JSON / 外形不对都回退初始值）。
import { describe, expect, it } from "vitest";
import { parseCommuteDisruptionState } from "../../src/domain/commute-disruption";
import { parseFootballNotifyState } from "../../src/domain/football-notify";
import { parseMorningBriefState } from "../../src/domain/morning-brief";

describe("parseCommuteDisruptionState", () => {
  it("null 回退为 fingerprint: null", () => {
    expect(parseCommuteDisruptionState(null)).toEqual({ fingerprint: null });
  });

  it("非法 JSON 回退为 fingerprint: null", () => {
    expect(parseCommuteDisruptionState("{not json")).toEqual({ fingerprint: null });
  });

  it("外形不对（缺 fingerprint）回退为 fingerprint: null", () => {
    expect(parseCommuteDisruptionState(JSON.stringify({ foo: "bar" }))).toEqual({ fingerprint: null });
  });

  it("fingerprint 不是字符串或 null 时回退", () => {
    expect(parseCommuteDisruptionState(JSON.stringify({ fingerprint: 123 }))).toEqual({ fingerprint: null });
  });

  it("正常值原样返回", () => {
    expect(parseCommuteDisruptionState(JSON.stringify({ fingerprint: "abc" }))).toEqual({ fingerprint: "abc" });
  });

  it("fingerprint 为 null 时原样返回", () => {
    expect(parseCommuteDisruptionState(JSON.stringify({ fingerprint: null }))).toEqual({ fingerprint: null });
  });

  // T4.6 item 5：空字符串是「无活跃异常」的存储态哨兵（RefreshWorker.kt 写入方式），视同 null。
  it("fingerprint 为空字符串时视为 null", () => {
    expect(parseCommuteDisruptionState(JSON.stringify({ fingerprint: "" }))).toEqual({ fingerprint: null });
  });
});

describe("parseMorningBriefState", () => {
  it("null 回退为 lastSentDate: null", () => {
    expect(parseMorningBriefState(null)).toEqual({ lastSentDate: null });
  });

  it("非法 JSON 回退为 lastSentDate: null", () => {
    expect(parseMorningBriefState("{not json")).toEqual({ lastSentDate: null });
  });

  it("外形不对（缺 lastSentDate）回退为 lastSentDate: null", () => {
    expect(parseMorningBriefState(JSON.stringify({ foo: "bar" }))).toEqual({ lastSentDate: null });
  });

  it("lastSentDate 不是字符串或 null 时回退", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: 123 }))).toEqual({ lastSentDate: null });
  });

  it("正常值原样返回", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: "2026-09-10" }))).toEqual({
      lastSentDate: "2026-09-10",
    });
  });

  // T4.6 item 5：对齐 Kotlin `LocalDate.parse`，只接受真实存在的严格 "yyyy-MM-dd"。
  it("不是真实存在的日期时回退为 null（2026-02-30）", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: "2026-02-30" }))).toEqual({ lastSentDate: null });
  });

  it("非法字符串时回退为 null（garbage）", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: "garbage" }))).toEqual({ lastSentDate: null });
  });

  it("空字符串时回退为 null", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: "" }))).toEqual({ lastSentDate: null });
  });

  it("月/日缺补零时回退为 null（2026-9-1）", () => {
    expect(parseMorningBriefState(JSON.stringify({ lastSentDate: "2026-9-1" }))).toEqual({ lastSentDate: null });
  });
});

describe("parseFootballNotifyState", () => {
  it("null 回退为空集合", () => {
    expect(parseFootballNotifyState(null)).toEqual({ kickoffNotifiedIds: [], finishedNotifiedIds: [] });
  });

  it("非法 JSON 回退为空集合", () => {
    expect(parseFootballNotifyState("{not json")).toEqual({ kickoffNotifiedIds: [], finishedNotifiedIds: [] });
  });

  it("外形不对（缺字段）回退为空集合", () => {
    expect(parseFootballNotifyState(JSON.stringify({ foo: "bar" }))).toEqual({
      kickoffNotifiedIds: [],
      finishedNotifiedIds: [],
    });
  });

  it("字段不是字符串数组时回退为空集合", () => {
    expect(
      parseFootballNotifyState(JSON.stringify({ kickoffNotifiedIds: [1, 2], finishedNotifiedIds: [] })),
    ).toEqual({ kickoffNotifiedIds: [], finishedNotifiedIds: [] });
  });

  it("正常值按升序排序返回", () => {
    expect(
      parseFootballNotifyState(
        JSON.stringify({ kickoffNotifiedIds: ["m10", "m2"], finishedNotifiedIds: ["b", "a"] }),
      ),
    ).toEqual({ kickoffNotifiedIds: ["m10", "m2"], finishedNotifiedIds: ["a", "b"] });
  });

  // T4.6 item 1：对齐 kotlinx 解码——字段缺失按默认值取 []（不是整体回退）。
  it("kickoffNotifiedIds 乱序、finishedNotifiedIds 缺失 → 只有 kickoffNotifiedIds 参与、finishedNotifiedIds 取默认 []", () => {
    expect(parseFootballNotifyState(JSON.stringify({ kickoffNotifiedIds: ["b", "a"] }))).toEqual({
      kickoffNotifiedIds: ["a", "b"],
      finishedNotifiedIds: [],
    });
  });

  it("finishedNotifiedIds 重复元素被去重（['c','c']）", () => {
    expect(parseFootballNotifyState(JSON.stringify({ finishedNotifiedIds: ["c", "c"] }))).toEqual({
      kickoffNotifiedIds: [],
      finishedNotifiedIds: ["c"],
    });
  });

  it("修改返回值不影响下一次解析 null 的结果（不共享同一个初始对象）", () => {
    const first = parseFootballNotifyState(null);
    first.kickoffNotifiedIds.push("mutated");
    expect(parseFootballNotifyState(null)).toEqual({ kickoffNotifiedIds: [], finishedNotifiedIds: [] });
  });

  it("commute 的初始状态也不是共享对象", () => {
    const a = parseCommuteDisruptionState(null);
    const b = parseCommuteDisruptionState(null);
    expect(a).not.toBe(b);
  });

  it("morning-brief 的初始状态也不是共享对象", () => {
    const a = parseMorningBriefState(null);
    const b = parseMorningBriefState(null);
    expect(a).not.toBe(b);
  });
});
