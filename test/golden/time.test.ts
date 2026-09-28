// 金标准：TimeUtils.parseIso / format 系列，逐字符对齐 Kotlin 端的输出。
import timeUtilsFormat from "../../../contracts/golden/time-utils.format.json";
import timeUtilsParseIso from "../../../contracts/golden/time-utils.parse-iso.json";
import timeSegmentsResolve from "../../../contracts/golden/time-segments.resolve.json";
import { delayMinutes, formatIsoHm, formatMinutes, osloParts, parseIso } from "../../src/util/time";
import { resolveTimeSegment } from "../../src/domain/time-segments";
import { runGolden } from "./harness";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 对齐 Kotlin `TimeUtils.isoOffset(parseIso(value))`：Date 对象自带毫秒，需要在偏移前
 * 补上 ".SSS"（毫秒为 0 时省略），osloIsoOffset 本身不带毫秒，这里只在测试里补一次。
 */
function isoOffsetWithMillis(date: Date): string {
  const p = osloParts(date);
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    timeZoneName: "shortOffset",
  });
  const tzName =
    offsetFormatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ??
    "GMT";
  const match = /^GMT([+-]\d+)(?::(\d+))?$/.exec(tzName);
  const hours = match?.[1] ? Number(match[1]) : 0;
  const minutes = match?.[2] ? Number(match[2]) : 0;
  const sign = hours < 0 ? "-" : "+";
  const offset = `${sign}${pad2(Math.abs(hours))}:${pad2(minutes)}`;
  const local = `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  const ms = date.getUTCMilliseconds();
  // 对齐 Kotlin DateTimeFormatter.ISO_OFFSET_DATE_TIME：小数秒按纳秒最少位数输出（去掉尾部的
  // 0），整秒不带小数点；不能像 Date 自身那样固定补到 3 位（".500" 在 Kotlin 端是 ".5"）。
  const fraction = ms === 0 ? "" : `.${String(ms).padStart(3, "0").replace(/0+$/, "")}`;
  return `${local}${fraction}${offset}`;
}

runGolden(timeUtilsParseIso, (input) => {
  const { value } = input as { value: string | null };
  const parsed = parseIso(value);
  return parsed ? isoOffsetWithMillis(parsed) : null;
});

runGolden(timeUtilsFormat, (input) => {
  const { fn, args } = input as { fn: string; args: unknown[] };
  switch (fn) {
    case "formatIsoHm":
      return formatIsoHm(args[0] as string | null);
    case "delayMinutes":
      return delayMinutes(args[0] as string | null, args[1] as string | null);
    case "formatMinutes":
      return formatMinutes(args[0] as number);
    default:
      throw new Error(`未知的 fn: ${fn}`);
  }
});

runGolden(timeSegmentsResolve, (input) => {
  const { now } = input as { now: string };
  const parsed = parseIso(now);
  if (!parsed) throw new Error(`无法解析 now: ${now}`);
  return resolveTimeSegment(parsed);
});
