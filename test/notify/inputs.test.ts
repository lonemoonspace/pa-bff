// selectInputs 的输入选择规则（CONTRACT.md 6.2 节）。全部用固定时钟，不碰 D1。
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../src/contract/settings";
import { parseCommuteDisruptionState } from "../../src/domain/commute-disruption";
import { parseFootballNotifyState } from "../../src/domain/football-notify";
import { parseMorningBriefState } from "../../src/domain/morning-brief";
import { parseTicketState } from "../../src/domain/ticket";
import { selectInputs, serializeState, type NotifySnapshots } from "../../src/notify/inputs";
import type { SnapshotEnvelope } from "../../src/snapshot/store";

// 2026-01-13 是普通工作日、冬令时（Oslo = UTC+1），避开夏令时切换，方便手算 UTC 偏移。
const DAY = "2026-01-13";

function iso(hhmmUtc: string): string {
  return `${DAY}T${hhmmUtc}:00.000Z`;
}

function okEnvelope(data: unknown, fetchedAt: string): SnapshotEnvelope {
  return { state: "ok", fetchedAt, observedAt: fetchedAt, error: null, data };
}

const MINIMAL_TRAIN = { work: {}, home: {}, transfer: null };
const MINIMAL_WEATHER = { temperature: 5 };
const MINIMAL_FOOTBALL = { nextMatches: [] };

const emptySnapshots: NotifySnapshots = { train: null, weather: null, traffic_outbound: null, football: null };

describe("commute_disruption 的输入", () => {
  // WORK 07:00-10:00 Oslo = 06:00-09:00 UTC；RETURN 14:00-16:00 Oslo = 13:00-15:00 UTC。
  const now = new Date(iso("07:30")); // 08:30 Oslo，WORK 窗口内

  it("train 有效（同窗口、5 分钟内、能解析）→ commute 非 null", () => {
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope(MINIMAL_TRAIN, iso("07:26")) };
    const result = selectInputs(snaps, DEFAULT_SETTINGS, now);
    expect(result.commute).not.toBeNull();
  });

  it("train state=stale → commute null", () => {
    const snaps: NotifySnapshots = {
      ...emptySnapshots,
      train: { state: "stale", fetchedAt: iso("07:26"), observedAt: null, error: null, data: MINIMAL_TRAIN },
    };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train state=idle → commute null", () => {
    const snaps: NotifySnapshots = {
      ...emptySnapshots,
      train: { state: "idle", fetchedAt: iso("07:26"), observedAt: null, error: null, data: MINIMAL_TRAIN },
    };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train state=not_configured → commute null", () => {
    const snaps: NotifySnapshots = {
      ...emptySnapshots,
      train: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
    };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train 缺失（null）→ commute null", () => {
    expect(selectInputs(emptySnapshots, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train 过期（5 分 1 秒）→ commute null", () => {
    const fetchedAt = new Date(now.getTime() - (5 * 60 + 1) * 1000).toISOString();
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope(MINIMAL_TRAIN, fetchedAt) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train 恰好 5 分钟 → commute 有效", () => {
    const fetchedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope(MINIMAL_TRAIN, fetchedAt) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).not.toBeNull();
  });

  it("train data 解析失败（形状不对）→ commute null", () => {
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope("not-an-object", iso("07:26")) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).commute).toBeNull();
  });

  it("train 在 06:58 生成、now 07:01（WORK 07:00 开始）→ commute null（不同窗口）", () => {
    // Oslo 07:01 = 06:01 UTC；06:58 Oslo = 05:58 UTC，属于 OUTSIDE（WORK 尚未开始）。
    const nowAt0701 = new Date(iso("06:01"));
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope(MINIMAL_TRAIN, iso("05:58")) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, nowAt0701).commute).toBeNull();
  });

  it("当前窗口 OUTSIDE → commute null（即使 train 新鲜）", () => {
    const outsideNow = new Date(iso("11:00")); // 12:00 Oslo，OUTSIDE
    const snaps: NotifySnapshots = { ...emptySnapshots, train: okEnvelope(MINIMAL_TRAIN, iso("10:57")) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, outsideNow).commute).toBeNull();
  });
});

describe("football 的输入", () => {
  const now = new Date(iso("11:00"));

  it("有效 → 非 null", () => {
    const snaps: NotifySnapshots = { ...emptySnapshots, football: okEnvelope(MINIMAL_FOOTBALL, iso("10:00")) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).football).not.toBeNull();
  });

  it("过期（7 小时 1 秒）→ null", () => {
    const fetchedAt = new Date(now.getTime() - (7 * 3600 + 1) * 1000).toISOString();
    const snaps: NotifySnapshots = { ...emptySnapshots, football: okEnvelope(MINIMAL_FOOTBALL, fetchedAt) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).football).toBeNull();
  });

  it("恰好 7 小时 → 仍有效", () => {
    const fetchedAt = new Date(now.getTime() - 7 * 3600 * 1000).toISOString();
    const snaps: NotifySnapshots = { ...emptySnapshots, football: okEnvelope(MINIMAL_FOOTBALL, fetchedAt) };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).football).not.toBeNull();
  });
});

describe("morning_brief 的输入", () => {
  it("RETURN 窗口 → skip", () => {
    const now = new Date(iso("13:30")); // 14:30 Oslo，RETURN
    const result = selectInputs(emptySnapshots, DEFAULT_SETTINGS, now);
    expect(result.morning).toBe("skip");
  });

  it("OUTSIDE 窗口 → skip", () => {
    const now = new Date(iso("11:00"));
    expect(selectInputs(emptySnapshots, DEFAULT_SETTINGS, now).morning).toBe("skip");
  });

  it("07:00（窗口刚开始）traffic_outbound 为 idle 且带昨天数据 → defer", () => {
    const now = new Date(iso("06:00")); // 07:00 Oslo，窗口刚开始
    const snaps: NotifySnapshots = {
      train: okEnvelope(MINIMAL_TRAIN, iso("06:00")), // 与窗口开始同一时刻，train 本身有效
      weather: okEnvelope(MINIMAL_WEATHER, iso("05:00")),
      traffic_outbound: { state: "idle", fetchedAt: null, observedAt: null, error: null, data: { durationSec: 999 } },
      football: null,
    };
    expect(selectInputs(snaps, DEFAULT_SETTINGS, now).morning).toBe("defer");
  });

  it("07:10（宽限已过）同一输入 → traffic null、其余有效者照传", () => {
    const now = new Date(iso("06:10")); // 07:10 Oslo，宽限（<10分钟）已过
    const snaps: NotifySnapshots = {
      train: okEnvelope(MINIMAL_TRAIN, iso("06:08")), // WORK 窗口内、新鲜
      weather: okEnvelope(MINIMAL_WEATHER, iso("05:00")),
      traffic_outbound: { state: "idle", fetchedAt: null, observedAt: null, error: null, data: { durationSec: 999 } },
      football: null,
    };
    const result = selectInputs(snaps, DEFAULT_SETTINGS, now).morning;
    expect(result).not.toBe("skip");
    expect(result).not.toBe("defer");
    if (result === "skip" || result === "defer") throw new Error("unreachable");
    expect(result.traffic).toBeNull();
    expect(result.train).not.toBeNull();
    expect(result.weather).not.toBeNull();
  });

  it("地址为空（weather/traffic 快照 not_configured）→ 07:00 即评估、不 defer", () => {
    const now = new Date(iso("06:00")); // 07:00 Oslo
    const snaps: NotifySnapshots = {
      train: okEnvelope(MINIMAL_TRAIN, iso("06:00")), // WORK 窗口内、新鲜
      weather: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      traffic_outbound: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      football: null,
    };
    const result = selectInputs(snaps, DEFAULT_SETTINGS, now).morning;
    expect(result).not.toBe("defer");
    expect(result).not.toBe("skip");
    if (result === "skip" || result === "defer") throw new Error("unreachable");
    expect(result.weather).toBeNull();
    expect(result.traffic).toBeNull();
    expect(result.train).not.toBeNull();
  });

  it("[gate] P9：train not_configured（车站未选择）、其余两个来源有效 → 07:00 即评估、不 defer", () => {
    const now = new Date(iso("06:00")); // 07:00 Oslo，窗口刚开始（旧规则下 train 总是应有，会 defer）
    const snaps: NotifySnapshots = {
      train: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      weather: okEnvelope(MINIMAL_WEATHER, iso("05:00")),
      traffic_outbound: okEnvelope({ durationSec: 999 }, iso("05:55")),
      football: null,
    };
    const result = selectInputs(snaps, DEFAULT_SETTINGS, now).morning;
    expect(result).not.toBe("defer");
    expect(result).not.toBe("skip");
    if (result === "skip" || result === "defer") throw new Error("unreachable");
    expect(result.train).toBeNull();
    expect(result.weather).not.toBeNull();
    expect(result.traffic).not.toBeNull();
  });

  it("train stale → 07:05 defer、07:10 train null", () => {
    const staleTrain: SnapshotEnvelope = {
      state: "stale",
      fetchedAt: iso("05:58"),
      observedAt: null,
      error: null,
      data: MINIMAL_TRAIN,
    };
    const snapsAt0705: NotifySnapshots = {
      train: staleTrain,
      weather: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      traffic_outbound: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      football: null,
    };
    const nowAt0705 = new Date(iso("06:05")); // 07:05 Oslo，宽限内
    expect(selectInputs(snapsAt0705, DEFAULT_SETTINGS, nowAt0705).morning).toBe("defer");

    const nowAt0710 = new Date(iso("06:10")); // 07:10 Oslo，宽限已过
    const result = selectInputs(snapsAt0705, DEFAULT_SETTINGS, nowAt0710).morning;
    if (result === "skip" || result === "defer") throw new Error("unreachable");
    expect(result.train).toBeNull();
  });

  it("跨午夜窗口（23:00–01:00）在 00:05 的宽限按前一天 23:00 算", () => {
    const crossMidnightSettings: Settings = {
      ...DEFAULT_SETTINGS,
      workWindowStart: "23:00",
      workWindowEnd: "01:00",
    };
    // 00:05 Oslo（冬令时 UTC+1）= 前一天 23:05 UTC。2026-01-14 00:05 Oslo = 2026-01-13T23:05:00.000Z。
    const now = new Date("2026-01-13T23:05:00.000Z");
    // train 快照在「前一天 23:00 Oslo」窗口内生成（22:00 UTC），5 分钟内新鲜。
    const snaps: NotifySnapshots = {
      train: okEnvelope(MINIMAL_TRAIN, "2026-01-13T23:02:00.000Z"),
      weather: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      traffic_outbound: { state: "not_configured", fetchedAt: null, observedAt: null, error: null, data: null },
      football: null,
    };
    const result = selectInputs(snaps, crossMidnightSettings, now).morning;
    // 窗口开始时刻取前一天 23:00（不是「今天」00:05 所在日期的 23:00，那会晚于 now），
    // 00:05 距 23:00 已过 65 分钟、早已过了 10 分钟宽限，不应该 defer。
    expect(result).not.toBe("defer");
    expect(result).not.toBe("skip");
  });
});

describe("serializeState 与 parse*State 互逆", () => {
  it("commute_disruption", () => {
    const state = parseCommuteDisruptionState('{"fingerprint":"x"}');
    const json = serializeState("commute_disruption", state);
    expect(parseCommuteDisruptionState(json)).toEqual(state);
    expect(json).toBe('{"fingerprint":"x"}');
  });

  it("morning_brief", () => {
    const state = parseMorningBriefState('{"lastSentDate":"2026-01-01"}');
    const json = serializeState("morning_brief", state);
    expect(parseMorningBriefState(json)).toEqual(state);
    expect(json).toBe('{"lastSentDate":"2026-01-01"}');
  });

  it("football：数组升序", () => {
    const state = parseFootballNotifyState('{"kickoffNotifiedIds":["b","a"],"finishedNotifiedIds":["z","y"]}');
    const json = serializeState("football", state);
    expect(json).toBe('{"kickoffNotifiedIds":["a","b"],"finishedNotifiedIds":["y","z"]}');
    expect(parseFootballNotifyState(json)).toEqual(state);
  });

  it("ticket：数组升序", () => {
    const state = parseTicketState('{"keys":["b","a"]}');
    const json = serializeState("ticket", state);
    expect(json).toBe('{"keys":["a","b"]}');
    expect(parseTicketState(json)).toEqual(state);
  });
});
