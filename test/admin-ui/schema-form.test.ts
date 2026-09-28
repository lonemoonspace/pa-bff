// lib/schema-form.js 的纯函数测试：不碰 DOM，直接 import。
import { describe, expect, it } from "vitest";
import { buildFields, collectValues, diffSettings } from "../../admin-ui/public/admin/lib/schema-form.js";

const SCHEMA = {
  properties: {
    originAddress: { type: "string", maxLength: 200, default: "" },
    destinationAddress: { type: "string", maxLength: 200, default: "" },
    originStation: { type: "string", maxLength: 80, default: "Spikkestad" },
    destStation: { type: "string", maxLength: 80, default: "Nationaltheatret" },
    workWindowStart: { type: "string", maxLength: 5, default: "07:00" },
    workWindowEnd: { type: "string", maxLength: 5, default: "10:00" },
    returnWindowStart: { type: "string", maxLength: 5, default: "14:00" },
    returnWindowEnd: { type: "string", maxLength: 5, default: "16:00" },
    notifyCommuteDisruption: { type: "boolean", default: false },
    notifyFootballMatch: { type: "boolean", default: false },
    notifyMorningBrief: { type: "boolean", default: false },
    transitPassUntil: { type: "string", maxLength: 19, default: "" },
    parkingPassUntil: { type: "string", maxLength: 19, default: "" },
    notifyTicketExpiry: { type: "boolean", default: false },
  },
};

const LABELS = [
  { key: "originAddress", label: "出发地址", group: "地址" },
  { key: "destinationAddress", label: "目的地址", group: "地址" },
  { key: "originStation", label: "出发站", group: "车站" },
  { key: "destStation", label: "到达站", group: "车站" },
  { key: "workWindowStart", label: "上班开始", group: "时间窗" },
  { key: "workWindowEnd", label: "上班结束", group: "时间窗" },
  { key: "returnWindowStart", label: "下班开始", group: "时间窗" },
  { key: "returnWindowEnd", label: "下班结束", group: "时间窗" },
  { key: "notifyCommuteDisruption", label: "列车取消/延误提醒", group: "通知" },
  { key: "notifyFootballMatch", label: "皇马开赛/终场提醒", group: "通知" },
  { key: "notifyMorningBrief", label: "早间简报", group: "通知" },
  { key: "notifyTicketExpiry", label: "车票到期提醒", group: "通知" },
  { key: "transitPassUntil", label: "乘车月票到期", group: "车票" },
  { key: "parkingPassUntil", label: "停车票到期", group: "车票" },
];

describe("buildFields", () => {
  it("14 个字段，按 labels 顺序排列，布尔与字符串类型正确", () => {
    const fields = buildFields(SCHEMA, LABELS);
    expect(fields).toHaveLength(14);
    expect(fields.map((f) => f.key)).toEqual(LABELS.map((l) => l.key));
    expect(fields.find((f) => f.key === "originAddress")?.kind).toBe("string");
    expect(fields.find((f) => f.key === "originAddress")?.maxLength).toBe(200);
    expect(fields.find((f) => f.key === "notifyCommuteDisruption")?.kind).toBe("boolean");
    expect(fields.find((f) => f.key === "notifyCommuteDisruption")?.maxLength).toBeNull();
    expect(fields.find((f) => f.key === "originStation")?.label).toBe("出发站");
    expect(fields.find((f) => f.key === "originStation")?.group).toBe("车站");
  });

  it("schema 里有而 labels 里没有的字段排在最后，用 key 当标签", () => {
    const schemaWithExtra = {
      properties: { ...SCHEMA.properties, futureField: { type: "string", default: "" } },
    };
    const fields = buildFields(schemaWithExtra, LABELS);
    expect(fields).toHaveLength(15);
    expect(fields[fields.length - 1]?.key).toBe("futureField");
    expect(fields[fields.length - 1]?.label).toBe("futureField");
    expect(fields[fields.length - 1]?.group).toBe("其他");
  });
});

describe("collectValues", () => {
  it("往返：buildFields → collectValues 得到与原始设置一致的对象（字符串去首尾空白）", () => {
    const fields = buildFields(SCHEMA, LABELS);
    const raw: Record<string, unknown> = {
      originAddress: "  Storgata 1  ",
      destinationAddress: "Rådhusplassen 1",
      originStation: "Spikkestad",
      destStation: "Nationaltheatret",
      workWindowStart: "07:00",
      workWindowEnd: "10:00",
      returnWindowStart: "14:00",
      returnWindowEnd: "16:00",
      notifyCommuteDisruption: true,
      notifyFootballMatch: false,
      notifyMorningBrief: true,
      notifyTicketExpiry: false,
      transitPassUntil: "2026-09-24T23:59",
      parkingPassUntil: "",
    };
    const values = collectValues(fields, raw);
    expect(values.originAddress).toBe("Storgata 1");
    expect(values.notifyCommuteDisruption).toBe(true);
    expect(values.notifyFootballMatch).toBe(false);
    expect(values.transitPassUntil).toBe("2026-09-24T23:59");
  });

  it("布尔字段缺失时按 false 处理", () => {
    const fields = buildFields(SCHEMA, LABELS);
    const values = collectValues(fields, {});
    expect(values.notifyCommuteDisruption).toBe(false);
    expect(values.originAddress).toBe("");
  });
});

describe("diffSettings", () => {
  it("列出取值不同的字段名", () => {
    const a = { originStation: "Spikkestad", destStation: "Nationaltheatret", notifyMorningBrief: false };
    const b = { originStation: "Asker", destStation: "Nationaltheatret", notifyMorningBrief: true };
    expect(diffSettings(a, b)).toEqual(["originStation", "notifyMorningBrief"]);
  });

  it("完全相同时返回空数组", () => {
    const a = { originStation: "Spikkestad" };
    const b = { originStation: "Spikkestad" };
    expect(diffSettings(a, b)).toEqual([]);
  });
});
