// Europe/Oslo 本地时间工具。夏令时切换一律交给 Intl.DateTimeFormat 处理，
// 不手写偏移表（欧洲的夏令时切换日期本身每年都在变）。

export interface OsloParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

/** 把 date 拆成 Europe/Oslo 本地时间的年月日时分秒。 */
export function osloParts(date: Date): OsloParts {
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Oslo",
  timeZoneName: "shortOffset",
});

/** 求 date 在 Europe/Oslo 的 UTC 偏移，形如 "+02:00" / "+01:00"。 */
function osloOffset(date: Date): string {
  const parts = offsetFormatter.formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // shortOffset 输出形如 "GMT+2" / "GMT+1" / "GMT" / "GMT+5:30"
  const match = /^GMT([+-]\d+)(?::(\d+))?$/.exec(tzName);
  const hours = match?.[1] ? Number(match[1]) : 0;
  const minutes = match?.[2] ? Number(match[2]) : 0;
  const sign = hours < 0 ? "-" : "+";
  const hh = String(Math.abs(hours)).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** ISO-8601 字符串，Europe/Oslo 本地时间 + 偏移，形如 "2026-09-23T07:32:00+02:00"。 */
export function osloIsoOffset(date: Date): string {
  const p = osloParts(date);
  const local = `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  return `${local}${osloOffset(date)}`;
}

/** "HH:mm"，Europe/Oslo 本地时间。 */
export function osloLocalTime(date: Date): string {
  const p = osloParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "yyyy-MM-dd"，Europe/Oslo 本地日期。 */
export function osloLocalDate(date: Date): string {
  const p = osloParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "yyyy-MM-ddTHH:mm"，Europe/Oslo 本地日期时间（不含秒）。 */
export function osloLocalDateTime(date: Date): string {
  const p = osloParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

// 是否闰年（用于校验 parseIso / ticket.parseUntil 里的日期是否真实存在）。
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/** 年月日时分秒是否为真实存在的时刻（拒绝 2026-02-30、24:00 这类值）。 */
function isValidDateTimeParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

// 带偏移的 ISO 时刻：yyyy-MM-ddT(或 t)HH:mm[:ss[.fraction]](Z/z 或 ±HH[:mm])。
// 对齐 Kotlin OffsetDateTime.parse：不带偏移的串在这里不匹配，交给下面的 RFC 1123 分支。
// 偏移分钟部分可省略（Kotlin OffsetDateTime.parse 接受 "+02" 这种短偏移）。
const ISO_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|z|[+-]\d{2}(?::\d{2})?)$/;

const RFC1123_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const RFC1123_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 对齐 Kotlin DateTimeFormatter.RFC_1123_DATE_TIME；只覆盖 GMT 与数字偏移两种常见写法。
// 日允许 1–2 位数字（RFC 1123 本身允许个位数日不补零）。
const RFC1123_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|[+-]\d{4})$/;

/** 偏移总量的上限：18 小时（对齐 Kotlin ZoneOffset 的合法范围 ±18:00）。 */
const MAX_OFFSET_MINUTES = 18 * 60;

/** 解析 ISO 偏移串（"Z" / "z" / "+02" / "+02:00"），分钟须 ≤59 且总偏移须 ≤18 小时，否则 null。 */
function parseIsoOffsetMinutes(offset: string): number | null {
  if (offset === "Z" || offset === "z") return 0;
  const match = /^([+-])(\d{2})(?::(\d{2}))?$/.exec(offset);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (minutes > 59) return null;
  const total = sign * (hours * 60 + minutes);
  if (Math.abs(total) > MAX_OFFSET_MINUTES) return null;
  return total;
}

/** 解析 RFC 1123 的时区串（"GMT" / "+0200"），规则同上。 */
function parseRfcOffsetMinutes(zone: string): number | null {
  if (zone === "GMT") return 0;
  const match = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59) return null;
  const total = sign * (hours * 60 + minutes);
  if (Math.abs(total) > MAX_OFFSET_MINUTES) return null;
  return total;
}

/**
 * 对齐 Kotlin `TimeUtils.parseIso`：只接受带偏移的 ISO 串（`Z`/`z` 或 `±HH[:mm]`）或 RFC 1123 格式；
 * 不带偏移的串（如纯日期、无时区的 datetime）一律返回 null，不能用 `Date.parse` 代替
 * （它会把 `2026-09-10` 当作 UTC 零点接受，与 Kotlin 行为不一致）。
 */
export function parseIso(s: string | null | undefined): Date | null {
  if (s == null || s.trim() === "") return null;

  const isoMatch = ISO_OFFSET_RE.exec(s);
  if (isoMatch) {
    const [, yy, mm, dd, hh, mi, ss, frac, offset] = isoMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string,
    ];
    const year = Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    const hour = Number(hh);
    const minute = Number(mi);
    const second = ss ? Number(ss) : 0;
    if (!isValidDateTimeParts(year, month, day, hour, minute, second)) return null;
    // 小数秒转毫秒须向零截断（对齐 Kotlin 纳秒截断行为），不能用 Math.round：
    // ".9996" 秒是 999.6ms，截断为 999ms，而不是四舍五入到 1000ms（那会进位到下一秒）。
    const ms = frac ? Math.trunc(Number(frac) * 1000) : 0;
    const offsetMinutes = parseIsoOffsetMinutes(offset);
    if (offsetMinutes === null) return null;
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
    return new Date(utcMs);
  }

  const rfcMatch = RFC1123_RE.exec(s);
  if (rfcMatch) {
    const [, weekday, dd, mon, yyyy, hh, mi, ss, zone] = rfcMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const monthIndex = RFC1123_MONTHS.indexOf(mon);
    if (monthIndex < 0) return null;
    const year = Number(yyyy);
    const day = Number(dd);
    const hour = Number(hh);
    const minute = Number(mi);
    const second = Number(ss);
    if (!isValidDateTimeParts(year, monthIndex + 1, day, hour, minute, second)) return null;
    // RFC 1123 的星期字段是冗余信息，Java 的严格解析会校验它与日期是否一致；星期不符时
    // 直接判失败，而不是悄悄忽略（用户/上游传错星期往往意味着日期本身也传错了）。
    const actualWeekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
    if (RFC1123_WEEKDAYS[actualWeekday] !== weekday) return null;
    const offsetMinutes = parseRfcOffsetMinutes(zone);
    if (offsetMinutes === null) return null;
    const utcMs = Date.UTC(year, monthIndex, day, hour, minute, second) - offsetMinutes * 60000;
    return new Date(utcMs);
  }

  return null;
}

/** "HH:mm"，解析失败输出占位符 "--:--"（对齐 Kotlin `TimeUtils.formatIsoHm`）。 */
export function formatIsoHm(s: string | null | undefined): string {
  const d = parseIso(s);
  return d ? osloLocalTime(d) : "--:--";
}

/** b 减 a 的分钟数，向零截断（对齐 Kotlin `Duration.toMinutes()`，不要用 Math.round / Math.floor）。 */
export function minutesBetween(a: Date, b: Date): number {
  return Math.trunc((b.getTime() - a.getTime()) / 60000);
}

/** 延误分钟数，早到记为 0（对齐 Kotlin `TimeUtils.delayMinutes`）。 */
export function delayMinutes(
  aimed: string | null | undefined,
  expected: string | null | undefined,
): number | null {
  const a = parseIso(aimed);
  const e = parseIso(expected);
  if (!a || !e) return null;
  return Math.max(0, minutesBetween(a, e));
}

/** 时长取整到分钟："25 分钟"，不足一分钟写 "<1 分钟"（对齐 Kotlin `TimeUtils.formatMinutes`）。 */
export function formatMinutes(seconds: number): string {
  if (seconds < 60) return "<1 分钟";
  return `${Math.round(seconds / 60)} 分钟`;
}
