// domain/ticket.ts 里没有金标准覆盖的部分：parseTicketState 的回退行为。
import { describe, expect, it } from "vitest";
import { parseTicketState } from "../../src/domain/ticket";

describe("parseTicketState", () => {
  it("null 回退为空 keys", () => {
    expect(parseTicketState(null)).toEqual({ keys: [] });
  });

  it("非法 JSON 回退为空 keys", () => {
    expect(parseTicketState("{not json")).toEqual({ keys: [] });
  });

  it("外形不对（缺 keys）回退为空 keys", () => {
    expect(parseTicketState(JSON.stringify({ foo: "bar" }))).toEqual({ keys: [] });
  });

  it("keys 不是字符串数组时回退为空 keys", () => {
    expect(parseTicketState(JSON.stringify({ keys: [1, 2] }))).toEqual({ keys: [] });
  });

  it("正常值按升序排序返回", () => {
    expect(parseTicketState(JSON.stringify({ keys: ["b", "a"] }))).toEqual({ keys: ["a", "b"] });
  });
});
