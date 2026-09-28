// @ts-check
// 纯格式化函数，不碰 DOM，供 pages/*.js 与 test/admin-ui/format.test.ts 共用。

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 相对时间："刚刚 / 3 分钟前 / 2 小时前 / 5 天前"；未来时刻用「…后」；
 * iso 为 null 或无法解析时输出 "—"。
 * @param {string | null} iso
 * @param {number} nowMs
 * @returns {string}
 */
export function relativeTime(iso, nowMs) {
  if (iso === null || iso === undefined) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";

  const diffMs = nowMs - t;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const suffix = future ? "后" : "前";

  if (abs < MINUTE_MS) return "刚刚";
  if (abs < HOUR_MS) return `${Math.floor(abs / MINUTE_MS)} 分钟${suffix}`;
  if (abs < DAY_MS) return `${Math.floor(abs / HOUR_MS)} 小时${suffix}`;
  return `${Math.floor(abs / DAY_MS)} 天${suffix}`;
}

const osloDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * "MM-dd HH:mm"，按 Europe/Oslo 本地时间；iso 为 null 或无法解析时输出 "—"。
 * @param {string | null} iso
 * @returns {string}
 */
export function osloDateTime(iso) {
  if (iso === null || iso === undefined) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const parts = osloDateTimeFormatter.formatToParts(new Date(t));
  /** @param {string} type */
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * 来源状态的中文文案；state 为 null（快照不存在）时「无数据」。
 * @param {"ok" | "stale" | "not_configured" | "idle" | null} state
 * @returns {string}
 */
export function sourceStateLabel(state) {
  switch (state) {
    case "ok":
      return "正常";
    case "stale":
      return "过期";
    case "not_configured":
      return "未配置";
    case "idle":
      return "空闲";
    default:
      return "无数据";
  }
}

/**
 * 总览「设置匹配」列的文案：从未抓取过（state 为 null）时不应误标为「设置已变更」，
 * 只有已经抓取过但 config_key 与当前设置不一致时才提示需要等待下次刷新。
 * @param {{ state: "ok" | "stale" | "not_configured" | "idle" | null, configMatches: boolean }} row
 * @returns {string}
 */
export function sourceNote(row) {
  if (row.state === null) return "尚无数据";
  if (!row.configMatches) return "设置已变更，等待下次刷新";
  return "是";
}

const STALE_TICK_MS = 3 * 60 * 1000;

/**
 * 调度健康状态：从未运行过（lastTickAt 为 null）→ "never"；
 * 距上次运行超过 3 分钟 → "stale"；否则 "ok"。
 * @param {string | null} lastTickAt
 * @param {number} nowMs
 * @returns {"ok" | "stale" | "never"}
 */
export function tickHealth(lastTickAt, nowMs) {
  if (lastTickAt === null) return "never";
  const t = Date.parse(lastTickAt);
  if (Number.isNaN(t)) return "never";
  return nowMs - t > STALE_TICK_MS ? "stale" : "ok";
}

/**
 * 配对码显示格式："XXXX-XXXX"（仅对 8 位输入生效，其余原样返回）。
 * 深链里的 code 参数仍应使用未加连字符的原始值。
 * @param {string} code
 * @returns {string}
 */
export function formatPairCode(code) {
  if (code.length !== 8) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
