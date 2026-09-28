// cadence.ts 是纯函数，直接单测，不需要 D1 / workers 运行时。
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../src/contract/settings";
import { resolveWindow } from "../../src/domain/windows";
import {
  backoffMinutes,
  nextRunAt,
  nextRunAtAfterFailure,
  osloLocalToUtc,
} from "../../src/scheduler/cadence";

const settings: Settings = DEFAULT_SETTINGS; // WORK 07:00-10:00, RETURN 14:00-16:00

describe("nextRunAt", () => {
  it("train：窗口内 2 分钟，窗口外 15 分钟", () => {
    const inside = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    const outside = osloLocalToUtc(2026, 8, 12, 12, 0, 0);
    expect(nextRunAt("train", inside, settings).getTime() - inside.getTime()).toBe(2 * 60_000);
    expect(nextRunAt("train", outside, settings).getTime() - outside.getTime()).toBe(15 * 60_000);
  });

  it("bus：06:00-23:30 每 5 分钟，其余 30 分钟", () => {
    const active = osloLocalToUtc(2026, 8, 12, 20, 0, 0);
    const idle = osloLocalToUtc(2026, 8, 12, 23, 45, 0);
    expect(nextRunAt("bus", active, settings).getTime() - active.getTime()).toBe(5 * 60_000);
    expect(nextRunAt("bus", idle, settings).getTime() - idle.getTime()).toBe(30 * 60_000);
    // 边界：06:00 算活跃，23:30 已经不算。
    const at0600 = osloLocalToUtc(2026, 8, 12, 6, 0, 0);
    const at2330 = osloLocalToUtc(2026, 8, 12, 23, 30, 0);
    expect(nextRunAt("bus", at0600, settings).getTime() - at0600.getTime()).toBe(5 * 60_000);
    expect(nextRunAt("bus", at2330, settings).getTime() - at2330.getTime()).toBe(30 * 60_000);
  });

  it("weather：默认 30 分钟，但不早于上次响应的 Expires", () => {
    const now = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    expect(nextRunAt("weather", now, settings).getTime() - now.getTime()).toBe(30 * 60_000);

    const farExpires = new Date(now.getTime() + 90 * 60_000);
    expect(nextRunAt("weather", now, settings, { weatherExpiresAt: farExpires })).toEqual(farExpires);

    // Expires 比 30 分钟更近时，仍然按 30 分钟的下限走（不会提前）。
    const nearExpires = new Date(now.getTime() + 5 * 60_000);
    const result = nextRunAt("weather", now, settings, { weatherExpiresAt: nearExpires });
    expect(result.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("traffic_outbound：WORK 窗口内 5 分钟；窗口外等到下一个 WORK 窗口开始", () => {
    const inside = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    expect(nextRunAt("traffic_outbound", inside, settings).getTime() - inside.getTime()).toBe(5 * 60_000);

    const beforeWindow = osloLocalToUtc(2026, 8, 12, 5, 0, 0);
    expect(nextRunAt("traffic_outbound", beforeWindow, settings)).toEqual(osloLocalToUtc(2026, 8, 12, 7, 0, 0));

    const afterWindowSameDay = osloLocalToUtc(2026, 8, 12, 12, 0, 0);
    expect(nextRunAt("traffic_outbound", afterWindowSameDay, settings)).toEqual(osloLocalToUtc(2026, 8, 13, 7, 0, 0));
  });

  it("traffic_return：RETURN 窗口内 5 分钟；窗口外等到下一个 RETURN 窗口开始", () => {
    const inside = osloLocalToUtc(2026, 8, 12, 15, 0, 0);
    expect(nextRunAt("traffic_return", inside, settings).getTime() - inside.getTime()).toBe(5 * 60_000);

    const beforeWindow = osloLocalToUtc(2026, 8, 12, 11, 0, 0);
    expect(nextRunAt("traffic_return", beforeWindow, settings)).toEqual(osloLocalToUtc(2026, 8, 12, 14, 0, 0));
  });

  it("traffic 窗口外的下一个窗口开始要跨过夏令时结束日，正确算出 UTC 偏移", () => {
    // 2026-10-25 是 DST 结束日；当天 07:00 本地已经是切换后的 CET(+01:00)。
    const now = osloLocalToUtc(2026, 10, 24, 23, 0, 0);
    const next = nextRunAt("traffic_outbound", now, settings);
    expect(next).toEqual(osloLocalToUtc(2026, 10, 25, 7, 0, 0));
    expect(next.toISOString()).toBe("2026-10-25T06:00:00.000Z");
  });

  it("football：默认 6 小时；开球前 90 分钟到终场之间每分钟", () => {
    const kickoffAt = osloLocalToUtc(2026, 8, 12, 20, 0, 0);
    const endAt = osloLocalToUtc(2026, 8, 12, 22, 0, 0);
    const idle = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    expect(nextRunAt("football", idle, settings, { football: { kickoffAt, endAt } }).getTime() - idle.getTime()).toBe(
      6 * 60 * 60_000,
    );

    const justBeforeActive = osloLocalToUtc(2026, 8, 12, 18, 29, 0);
    expect(
      nextRunAt("football", justBeforeActive, settings, { football: { kickoffAt, endAt } }).getTime() -
        justBeforeActive.getTime(),
    ).toBe(6 * 60 * 60_000);

    const active = osloLocalToUtc(2026, 8, 12, 18, 30, 0); // 开球前 90 分钟
    expect(
      nextRunAt("football", active, settings, { football: { kickoffAt, endAt } }).getTime() - active.getTime(),
    ).toBe(60_000);

    const finished = osloLocalToUtc(2026, 8, 12, 22, 0, 0);
    expect(
      nextRunAt("football", finished, settings, { football: { kickoffAt, endAt } }).getTime() - finished.getTime(),
    ).toBe(6 * 60 * 60_000);
  });

  it("notify：每分钟", () => {
    const now = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    expect(nextRunAt("notify", now, settings).getTime() - now.getTime()).toBe(60_000);
  });

  it("housekeeping：每天本地 03:30，跨天正确进位", () => {
    const before = osloLocalToUtc(2026, 8, 12, 1, 0, 0);
    expect(nextRunAt("housekeeping", before, settings)).toEqual(osloLocalToUtc(2026, 8, 12, 3, 30, 0));

    const after = osloLocalToUtc(2026, 8, 12, 4, 0, 0);
    expect(nextRunAt("housekeeping", after, settings)).toEqual(osloLocalToUtc(2026, 8, 13, 3, 30, 0));

    // DST 结束日：03:30 本地在切换完成之后，只会出现一次，不受「02:00-03:00 重复一小时」影响。
    const dstDay = osloLocalToUtc(2026, 10, 25, 1, 0, 0);
    const next = nextRunAt("housekeeping", dstDay, settings);
    expect(next.toISOString()).toBe("2026-10-25T02:30:00.000Z");
  });
});

describe("backoffMinutes / nextRunAtAfterFailure", () => {
  it("失败退避序列：2、4、8、16、30、30 分钟", () => {
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(2)).toBe(4);
    expect(backoffMinutes(3)).toBe(8);
    expect(backoffMinutes(4)).toBe(16);
    expect(backoffMinutes(5)).toBe(30);
    expect(backoffMinutes(6)).toBe(30);
  });

  it("G3 修复 4：退避只按 backoff(fail_count) 走，不再与正常间隔取 min", () => {
    // notify 正常间隔只有 1 分钟，远小于退避分钟数；旧逻辑会跟正常间隔取 min，
    // 把失败第 3 次的间隔也拉回 1 分钟——新契约不再这样，老老实实等 backoff(3)=8 分钟。
    const now = osloLocalToUtc(2026, 8, 12, 8, 0, 0);
    const next = nextRunAtAfterFailure("notify", now, settings, 3);
    expect(next.getTime() - now.getTime()).toBe(8 * 60_000);

    // housekeeping 同理：失败第 2 次固定是 backoff(2)=4 分钟，不管正常间隔多长。
    const beforeHousekeeping = osloLocalToUtc(2026, 8, 12, 1, 0, 0);
    const hkNext = nextRunAtAfterFailure("housekeeping", beforeHousekeeping, settings, 2);
    expect(hkNext.getTime() - beforeHousekeeping.getTime()).toBe(4 * 60_000);
  });
});

describe("osloLocalToUtc：夏令时切换（G3 修复 6）", () => {
  it("春季切换当天不存在的本地时刻（空隙）顺延到切换后", () => {
    // 2026-03-29 是春季切换日：本地时钟从 02:00 直接跳到 03:00，02:00-03:00 之间的
    // 本地时刻根本不存在。顺延到切换后意味着 02:00 -> 03:00、02:30 -> 03:30。
    expect(osloLocalToUtc(2026, 3, 29, 2, 0).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(osloLocalToUtc(2026, 3, 29, 2, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("秋季切换重复出现的本地时刻取第一次出现（夏令时偏移 +2h）", () => {
    // 2026-10-25 是秋季切换日：02:00-03:00 会被走过两遍，第一遍是夏令时 CEST(+2)，
    // 第二遍是冬令时 CET(+1)。取第一次出现即取更早的那个真实时刻（+2h 那个）。
    expect(osloLocalToUtc(2026, 10, 25, 2, 30).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("窗口判定在春季切换当天用顺延后的时刻，落在正确窗口里", () => {
    // WORK 窗口设成 02:30–05:00（覆盖切换空隙）；now = 2026-03-28T23:00Z，
    // 对应 Oslo 本地 2026-03-29 00:00（切换前 CET +1），此时在窗口外。
    // 下一次 WORK 窗口开始本该是本地 02:30，但那一刻不存在，顺延到 03:30（切换后
    // CEST +2）= UTC 01:30，并且这个顺延后的时刻确实落在 WORK 窗口内。
    const customSettings: Settings = { ...DEFAULT_SETTINGS, workWindowStart: "02:30", workWindowEnd: "05:00" };
    const now = new Date("2026-03-28T23:00:00.000Z");
    const next = nextRunAt("traffic_outbound", now, customSettings);
    expect(next.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(resolveWindow(next, customSettings)).toBe("WORK");
  });
});
