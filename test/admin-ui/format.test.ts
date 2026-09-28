// lib/format.js 的纯函数测试：不碰 DOM，直接 import。
import { describe, expect, it } from "vitest";
import {
  formatPairCode,
  osloDateTime,
  relativeTime,
  sourceNote,
  sourceStateLabel,
  tickHealth,
} from "../../admin-ui/public/admin/lib/format.js";

describe("relativeTime", () => {
  const now = Date.parse("2026-09-22T10:00:00.000Z");

  it("null → 「—」", () => {
    expect(relativeTime(null, now)).toBe("—");
  });

  it("30 秒前 → 「刚刚」", () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe("刚刚");
  });

  it("3 分钟前 → 「3 分钟前」", () => {
    expect(relativeTime(new Date(now - 3 * 60_000).toISOString(), now)).toBe("3 分钟前");
  });

  it("2 小时前 → 「2 小时前」", () => {
    expect(relativeTime(new Date(now - 2 * 3600_000).toISOString(), now)).toBe("2 小时前");
  });

  it("5 天前 → 「5 天前」", () => {
    expect(relativeTime(new Date(now - 5 * 86_400_000).toISOString(), now)).toBe("5 天前");
  });

  it("未来 3 分钟 → 「3 分钟后」", () => {
    expect(relativeTime(new Date(now + 3 * 60_000).toISOString(), now)).toBe("3 分钟后");
  });

  it("无法解析的字符串 → 「—」", () => {
    expect(relativeTime("not-a-date", now)).toBe("—");
  });
});

describe("osloDateTime", () => {
  it("null → 「—」", () => {
    expect(osloDateTime(null)).toBe("—");
  });

  it("冬令时（UTC+1）：2026-01-15T10:32:00Z → 01-15 11:32", () => {
    expect(osloDateTime("2026-01-15T10:32:00.000Z")).toBe("01-15 11:32");
  });

  it("夏令时切换后一侧（UTC+2）：2026-06-15T10:32:00Z → 06-15 12:32", () => {
    expect(osloDateTime("2026-06-15T10:32:00.000Z")).toBe("06-15 12:32");
  });

  it("夏令时切换日两侧：2026-03-29 UTC+1/UTC+2 分界", () => {
    // 2026 年欧洲夏令时从 3 月最后一个周日 01:00 UTC 开始（此处为 3 月 29 日）。
    expect(osloDateTime("2026-03-29T00:30:00.000Z")).toBe("03-29 01:30"); // 切换前：UTC+1
    expect(osloDateTime("2026-03-29T01:30:00.000Z")).toBe("03-29 03:30"); // 切换后：UTC+2
  });

  it("无法解析的字符串 → 「—」", () => {
    expect(osloDateTime("not-a-date")).toBe("—");
  });
});

describe("sourceStateLabel", () => {
  it("ok → 正常", () => {
    expect(sourceStateLabel("ok")).toBe("正常");
  });
  it("stale → 过期", () => {
    expect(sourceStateLabel("stale")).toBe("过期");
  });
  it("not_configured → 未配置", () => {
    expect(sourceStateLabel("not_configured")).toBe("未配置");
  });
  it("idle → 空闲", () => {
    expect(sourceStateLabel("idle")).toBe("空闲");
  });
  it("null → 无数据", () => {
    expect(sourceStateLabel(null)).toBe("无数据");
  });
});

describe("sourceNote", () => {
  it("state 为 null → 尚无数据", () => {
    expect(sourceNote({ state: null, configMatches: false })).toBe("尚无数据");
  });

  it("已抓取且 configMatches → 是", () => {
    expect(sourceNote({ state: "ok", configMatches: true })).toBe("是");
  });

  it("已抓取但 configMatches 为 false → 设置已变更提示", () => {
    expect(sourceNote({ state: "ok", configMatches: false })).toBe("设置已变更，等待下次刷新");
  });
});

describe("tickHealth", () => {
  const now = Date.parse("2026-09-22T10:00:00.000Z");

  it("null → never", () => {
    expect(tickHealth(null, now)).toBe("never");
  });

  it("2 分钟前 → ok", () => {
    expect(tickHealth(new Date(now - 2 * 60_000).toISOString(), now)).toBe("ok");
  });

  it("4 分钟前 → stale", () => {
    expect(tickHealth(new Date(now - 4 * 60_000).toISOString(), now)).toBe("stale");
  });
});

describe("formatPairCode", () => {
  it("8 位 → 中间加连字符", () => {
    expect(formatPairCode("ABCD1234")).toBe("ABCD-1234");
  });

  it("非 8 位 → 原样返回", () => {
    expect(formatPairCode("ABC")).toBe("ABC");
    expect(formatPairCode("ABCDEFGHIJ")).toBe("ABCDEFGHIJ");
  });
});
