import { describe, expect, it } from "vitest";
import { osloIsoOffset, osloLocalTime, osloParts } from "../../src/util/time";

describe("osloIsoOffset", () => {
  it("2026-03-29 夏令时开始前用 +01:00", () => {
    expect(osloIsoOffset(new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29T01:30:00+01:00");
  });

  it("2026-03-29 夏令时开始后用 +02:00", () => {
    expect(osloIsoOffset(new Date("2026-03-29T02:00:00Z"))).toBe("2026-03-29T04:00:00+02:00");
  });

  it("2026-10-25 夏令时结束前用 +02:00", () => {
    expect(osloIsoOffset(new Date("2026-10-25T00:30:00Z"))).toBe("2026-10-25T02:30:00+02:00");
  });

  it("2026-10-25 夏令时结束后用 +01:00", () => {
    expect(osloIsoOffset(new Date("2026-10-25T02:00:00Z"))).toBe("2026-10-25T03:00:00+01:00");
  });
});

describe("osloLocalTime", () => {
  it("只输出 HH:mm", () => {
    expect(osloLocalTime(new Date("2026-09-23T07:32:00Z"))).toBe("09:32");
  });
});

describe("osloParts", () => {
  it("按 Europe/Oslo 本地时间拆分年月日时分秒", () => {
    expect(osloParts(new Date("2026-09-23T07:32:15Z"))).toEqual({
      year: 2026,
      month: 9,
      day: 23,
      hour: 9,
      minute: 32,
      second: 15,
    });
  });
});
