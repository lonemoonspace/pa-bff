// 对应 Kotlin WindowsTest.kt 的每个用例，外加一组夏令时结束当天（2026-10-25）的窗口判定。
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../src/contract/settings";
import { resolveWindow } from "../../src/domain/windows";
import { osloLocalToUtc } from "../../src/scheduler/cadence";

// 2026-08-12 是普通夏令时（CEST，+02:00）日期，与 WindowsTest.kt 用的固定日期一致。
const t = (h: number, m: number) => osloLocalToUtc(2026, 8, 12, h, m, 0);

describe("resolveWindow（对应 WindowsTest.kt）", () => {
  it("resolvesDefaultWindows", () => {
    expect(resolveWindow(t(7, 0), DEFAULT_SETTINGS)).toBe("WORK");
    expect(resolveWindow(t(9, 59), DEFAULT_SETTINGS)).toBe("WORK");
    expect(resolveWindow(t(10, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
    expect(resolveWindow(t(14, 0), DEFAULT_SETTINGS)).toBe("RETURN");
    expect(resolveWindow(t(15, 59), DEFAULT_SETTINGS)).toBe("RETURN");
    expect(resolveWindow(t(16, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
    expect(resolveWindow(t(23, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
    expect(resolveWindow(t(3, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
  });

  it("equalWindowEndpointsDoNotBecomeAllDay", () => {
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      workWindowStart: "08:00",
      workWindowEnd: "08:00",
      returnWindowStart: "22:00",
      returnWindowEnd: "06:00",
    };
    expect(resolveWindow(t(12, 0), custom)).toBe("OUTSIDE");
    expect(resolveWindow(t(23, 0), custom)).toBe("RETURN");
    expect(resolveWindow(t(5, 59), custom)).toBe("RETURN");
  });

  it("respectsCustomWindows", () => {
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      workWindowStart: "06:30",
      workWindowEnd: "09:00",
      returnWindowStart: "15:30",
      returnWindowEnd: "18:00",
    };
    expect(resolveWindow(t(6, 0), custom)).toBe("OUTSIDE");
    expect(resolveWindow(t(6, 30), custom)).toBe("WORK");
    expect(resolveWindow(t(8, 59), custom)).toBe("WORK");
    expect(resolveWindow(t(9, 0), custom)).toBe("OUTSIDE");
    expect(resolveWindow(t(14, 0), custom)).toBe("OUTSIDE");
    expect(resolveWindow(t(17, 59), custom)).toBe("RETURN");
    expect(resolveWindow(t(18, 0), custom)).toBe("OUTSIDE");
  });

  it("无效 HH:mm 回退到默认窗口（缺失/格式不对/超出范围）", () => {
    const invalid: Settings = {
      ...DEFAULT_SETTINGS,
      workWindowStart: "not-a-time",
      workWindowEnd: "25:99",
      returnWindowStart: "",
      returnWindowEnd: "14:00", // 与默认 returnWindowEnd 相同，走默认 returnWindowStart=14:00 一起判断
    };
    // workWindowStart/End 都回退默认 07:00-10:00
    expect(resolveWindow(t(8, 0), invalid)).toBe("WORK");
  });

  it("2026-10-25 夏令时结束当天，窗口判定正确", () => {
    // 默认窗口 WORK 07:00-10:00、RETURN 14:00-16:00，转换全部发生在凌晨 3 点之前完成，
    // 07:00/14:00 这些时刻本身不受切换瞬间影响，但用来验证 osloLocalToUtc + osloParts
    // 在 DST 结束日仍然给出正确的本地时刻判定（而不是沿用切换前的固定偏移）。
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 7, 0, 0), DEFAULT_SETTINGS)).toBe("WORK");
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 9, 59, 0), DEFAULT_SETTINGS)).toBe("WORK");
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 10, 0, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 14, 0, 0), DEFAULT_SETTINGS)).toBe("RETURN");
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 15, 59, 0), DEFAULT_SETTINGS)).toBe("RETURN");
    expect(resolveWindow(osloLocalToUtc(2026, 10, 25, 16, 0, 0), DEFAULT_SETTINGS)).toBe("OUTSIDE");
    // 切换瞬间前后各取一个点，确认 07:00 当天用的是切换后的 CET(+01:00) 偏移。
    expect(osloLocalToUtc(2026, 10, 25, 7, 0, 0).toISOString()).toBe("2026-10-25T06:00:00.000Z");
  });
});
