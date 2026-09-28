// 对应 app/.../domain/WatchedLinePolicyTest.kt 的可移植用例（取代 Bus280PolicyTest /
// test/domain/bus280.test.ts）。样例站点/线路全部是虚构值（P9 通用约定）：站 A = Alpha
// (NSR:StopPlace:90001)，站 B = Beta (NSR:StopPlace:90002)，线路号 "42"。
import { describe, expect, it } from "vitest";
import {
  FETCH_LIMIT,
  type BusBoard,
  type BusCall,
  type QuayRef,
  type WatchedLineConfig,
  board,
  countdownText,
  passesThrough,
  status,
  visibleBoard,
  visibleBoards,
} from "../../src/domain/watched-line";
import { osloIsoOffset } from "../../src/util/time";

const now = new Date("2026-09-22T06:00:00.000Z"); // Oslo 08:00（夏令时 +02:00）

const LINE = "42";
const ALPHA_ID = "NSR:StopPlace:90001";
const BETA_ID = "NSR:StopPlace:90002";
const MID_ID = "NSR:StopPlace:90003";
const ALPHA = "Alpha";
const BETA = "Beta";

const config: WatchedLineConfig = {
  lineCode: LINE,
  stopA: { id: ALPHA_ID, name: ALPHA },
  stopB: { id: BETA_ID, name: BETA },
};

function at(hour: number, minute: number): string {
  return osloIsoOffset(new Date(Date.UTC(2026, 8, 22, hour - 2, minute, 0)));
}

/** 站序里的一站，可选带父站 id（[gate] P10 修正）。 */
function q(id: string, parentId?: string): QuayRef {
  return parentId === undefined ? { id } : { id, parentId };
}

function call(
  opts: Partial<BusCall> & { aimed?: string | null; expected?: string | null; quays?: QuayRef[] } = {},
): BusCall {
  return {
    line: opts.line ?? LINE,
    destName: opts.destName ?? BETA,
    aimedDep: opts.aimed ?? null,
    expectedDep: opts.expected ?? null,
    realtime: opts.realtime ?? false,
    cancelled: opts.cancelled ?? false,
    quays: opts.quays ?? [q(ALPHA_ID), q(BETA_ID)],
  };
}

function hhmm(b: BusBoard): string[] {
  return b.departures.map((d) => osloLocalTime(d.depTime));
}

function osloLocalTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

function boardAlpha(calls: BusCall[]): BusBoard {
  return board(calls, LINE, ALPHA_ID, BETA_ID, ALPHA, BETA, now);
}

function boardBeta(calls: BusCall[]): BusBoard {
  return board(calls, LINE, BETA_ID, ALPHA_ID, BETA, ALPHA, now);
}

// ---- 方向判定（站序） ----

describe("passesThrough：方向判定按站序，不看终点文案", () => {
  it("对端站出现在本站之后 → true", () => {
    expect(passesThrough([q(ALPHA_ID), q(MID_ID), q(BETA_ID)], ALPHA_ID, BETA_ID)).toBe(true);
  });

  it("对端站在本站之前（反向班次） → false", () => {
    expect(passesThrough([q(BETA_ID), q(MID_ID), q(ALPHA_ID)], ALPHA_ID, BETA_ID)).toBe(false);
  });

  it("站序里没有对端站（只开到中途的区间车） → false", () => {
    expect(passesThrough([q(ALPHA_ID), q(MID_ID)], ALPHA_ID, BETA_ID)).toBe(false);
  });

  it("站序里没有本站 → false", () => {
    expect(passesThrough([q(MID_ID), q(BETA_ID)], ALPHA_ID, BETA_ID)).toBe(false);
  });

  it("fromId / toId 为空串 → false", () => {
    expect(passesThrough([q(ALPHA_ID), q(BETA_ID)], "", BETA_ID)).toBe(false);
    expect(passesThrough([q(ALPHA_ID), q(BETA_ID)], ALPHA_ID, "")).toBe(false);
  });

  // ---- [gate] P10 修正：站的匹配也认父站（CONTRACT 第 9 节） ----

  it("设置是父站，站序是带 parentId 的子站 → true", () => {
    const parentA = "NSR:StopPlace:91001";
    const parentB = "NSR:StopPlace:91002";
    expect(passesThrough([q(ALPHA_ID, parentA), q(BETA_ID, parentB)], parentA, parentB)).toBe(true);
  });

  it("站序子站的 parentId 是别的站 → false", () => {
    const parentA = "NSR:StopPlace:91001";
    expect(passesThrough([q(ALPHA_ID, parentA), q(BETA_ID, "NSR:StopPlace:99999")], parentA, "NSR:StopPlace:91002")).toBe(
      false,
    );
  });

  it("设置是子站，站序是同一子站（没有 parentId）→ true", () => {
    expect(passesThrough([q(ALPHA_ID), q(BETA_ID)], ALPHA_ID, BETA_ID)).toBe(true);
  });
});

describe("board：方向过滤（对应 Bus280PolicyTest 的方向用例）", () => {
  it("A 站保留经站序真正到达 B 的班次，区间车被排除", () => {
    const calls = [
      call({ aimed: at(8, 7), quays: [q(ALPHA_ID), q(MID_ID)] }),
      call({ aimed: at(8, 17), quays: [q(ALPHA_ID), q(MID_ID)] }),
      call({ aimed: at(8, 57), quays: [q(ALPHA_ID), q(MID_ID), q(BETA_ID)] }),
    ];

    const b = boardAlpha(calls);

    expect(hhmm(b)).toEqual(["08:57"]);
    expect(b.boardStop).toBe(ALPHA);
    expect(b.towardStop).toBe(BETA);
  });

  it("B 站保留开往 A 的班次", () => {
    const calls = [
      call({ aimed: at(8, 29), quays: [q(BETA_ID), q(MID_ID), q(ALPHA_ID)] }),
      call({ aimed: at(9, 29), quays: [q(BETA_ID), q(MID_ID), q(ALPHA_ID)] }),
    ];

    const b = boardBeta(calls);

    expect(hhmm(b)).toEqual(["08:29", "09:29"]);
  });

  it("a board never picks up departures heading the other way", () => {
    const calls = [call({ aimed: at(8, 7), quays: [q(BETA_ID), q(MID_ID), q(ALPHA_ID)] })];

    expect(boardAlpha(calls).departures).toEqual([]);
  });

  it("board filters by line code, not just by destination", () => {
    const calls = [
      call({ line: "99", aimed: at(8, 5) }),
      call({ line: "L1", aimed: at(8, 6) }),
      call({ aimed: at(8, 57) }),
    ];

    expect(hhmm(boardAlpha(calls))).toEqual(["08:57"]);
  });
});

// ---- 时刻与排序 ----

describe("board：时刻与排序", () => {
  it("board drops departures that already left and keeps one departing exactly now", () => {
    const calls = [call({ aimed: at(7, 57) }), call({ aimed: at(8, 0) }), call({ aimed: at(8, 30) })];

    expect(hhmm(boardAlpha(calls))).toEqual(["08:00", "08:30"]);
  });

  it("board sorts by departure time regardless of input order", () => {
    const calls = [call({ aimed: at(9, 57) }), call({ aimed: at(8, 27) }), call({ aimed: at(8, 57) })];

    expect(hhmm(boardAlpha(calls))).toEqual(["08:27", "08:57", "09:57"]);
  });

  it("board keeps at most FETCH_LIMIT departures", () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      call({ aimed: new Date(now.getTime() + i * 5 * 60_000).toISOString() }),
    );

    const b = boardAlpha(calls);

    expect(b.departures).toHaveLength(FETCH_LIMIT);
    expect(osloLocalTime(b.departures[0]!.depTime)).toBe("08:00");
  });

  it("board ignores calls whose departure time cannot be parsed", () => {
    const calls = [call({ aimed: null, expected: null }), call({ aimed: "not-a-time" }), call({ aimed: at(8, 57) })];

    expect(hhmm(boardAlpha(calls))).toEqual(["08:57"]);
  });

  it("board prefers the expected departure time over the aimed one", () => {
    const calls = [
      call({ aimed: at(8, 57), expected: at(9, 2), realtime: true }),
      call({ aimed: at(9, 27), expected: " ", realtime: false }),
    ];

    expect(hhmm(boardAlpha(calls))).toEqual(["09:02", "09:27"]);
  });
});

// ---- 正晚点 ----

describe("board：正晚点", () => {
  it("realtime delay is reported in minutes", () => {
    const calls = [call({ aimed: at(8, 57), expected: at(9, 4), realtime: true })];

    const departure = boardAlpha(calls).departures[0]!;

    expect(departure.delayMin).toBe(7);
    expect(departure.delayKnown).toBe(true);
  });

  it("a departure without realtime data is reported as unknown, not on time", () => {
    const calls = [call({ aimed: at(8, 57), expected: at(8, 57), realtime: false })];

    const departure = boardAlpha(calls).departures[0]!;

    expect(departure.delayMin).toBe(0);
    expect(departure.delayKnown).toBe(false);
  });

  it("a cancelled departure is known regardless of the realtime flag", () => {
    const calls = [call({ aimed: at(8, 57), expected: null, realtime: false, cancelled: true })];

    const departure = boardAlpha(calls).departures[0]!;

    expect(departure.cancelled).toBe(true);
    expect(departure.delayKnown).toBe(true);
  });
});

// ---- 展示裁剪（缓存与时钟分离） ----

describe("visibleBoard / visibleBoards", () => {
  it("keeps only the next two departures and re-anchors on the current clock", () => {
    const calls = Array.from({ length: 6 }, (_, i) =>
      call({ aimed: new Date(now.getTime() + (i + 1) * 10 * 60_000).toISOString() }),
    );
    const b = boardAlpha(calls);

    expect(hhmm(visibleBoard(b, now))).toEqual(["08:10", "08:20"]);

    const later = new Date(now.getTime() + 25 * 60_000); // Oslo 08:25
    expect(hhmm(visibleBoard(b, later))).toEqual(["08:30", "08:40"]);

    const after = new Date(now.getTime() + 90 * 60_000); // Oslo 09:30
    expect(visibleBoard(b, after).departures).toEqual([]);
  });

  it("returns null for a null status so the card can show loading", () => {
    expect(visibleBoards(null, now)).toBeNull();
  });
});

// ---- 倒计时文案 ----

describe("countdownText", () => {
  it("is expressed in whole minutes, and a bus leaving now is not zero minutes", () => {
    expect(countdownText(now, at(8, 12))).toBe("还有 12 分钟");
    expect(countdownText(now, at(8, 0))).toBe("即将发车");
    expect(countdownText(now, at(8, 1))).toBe("还有 1 分钟");
  });

  it("is null for departed or unparsable times", () => {
    expect(countdownText(now, at(7, 59))).toBeNull();
    expect(countdownText(now, null)).toBeNull();
    expect(countdownText(now, "")).toBeNull();
    expect(countdownText(now, "not-a-time")).toBeNull();
  });
});

// ---- 快照与不变量 ----

describe("status", () => {
  it("builds both boards in A-then-B order, passes updatedAt / lineCode through", () => {
    const s = status(
      config,
      [call({ aimed: at(8, 57) })],
      [call({ aimed: at(8, 29), quays: [q(BETA_ID), q(ALPHA_ID)] })],
      now,
      "2026-09-22T08:00:00+02:00",
    );

    expect(s.boards.map((b) => b.boardStop)).toEqual([ALPHA, BETA]);
    expect(s.boards.map((b) => b.towardStop)).toEqual([BETA, ALPHA]);
    expect(s.updatedAt).toBe("2026-09-22T08:00:00+02:00");
    expect(s.lineCode).toBe(LINE);
  });

  it("no calls at all yields two empty boards (the card shows a single no-service line)", () => {
    const s = status(config, [], [], now, "x");

    expect(s.boards).toHaveLength(2);
    expect(s.boards.every((b) => b.departures.length === 0)).toBe(true);
  });
});
