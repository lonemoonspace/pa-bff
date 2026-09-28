// 从 Android app/.../domain/Windows.kt 逐行移植：判断给定时刻落在 WORK（上班通勤）、
// RETURN（下班通勤）还是 OUTSIDE（窗口外）。规则与 Kotlin 版完全一致：
// - start == end 视为「未设置」，不当成全天窗口；
// - end 早于 start 视为跨午夜窗口（例如 22:00–06:00）；
// - HH:mm 解析失败（缺失、格式不对、超出范围）一律回退到默认窗口。
import type { Settings } from "../contract/settings";
import { osloParts } from "../util/time";

export type CommuteWindow = "WORK" | "RETURN" | "OUTSIDE";

export interface LocalHm {
  hour: number;
  minute: number;
}

const DEFAULT_WORK_START: LocalHm = { hour: 7, minute: 0 };
const DEFAULT_WORK_END: LocalHm = { hour: 10, minute: 0 };
const DEFAULT_RETURN_START: LocalHm = { hour: 14, minute: 0 };
const DEFAULT_RETURN_END: LocalHm = { hour: 16, minute: 0 };

/** 解析 "HH:mm"；解析失败（含缺失、非法格式、超出 0-23/0-59 范围）回退到 def，与 Kotlin 的 LocalTime.parse 失败回退一致。 */
export function parseHm(value: string | undefined, def: LocalHm): LocalHm {
  if (!value) return def;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return def;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return def;
  return { hour, minute };
}

function toMinutes(t: LocalHm): number {
  return t.hour * 60 + t.minute;
}

/** 与 Kotlin 的 inWindow 逐行对应：start==end 恒为 false；end>start 为普通窗口；否则跨午夜。 */
function inWindow(t: LocalHm, start: LocalHm, end: LocalHm): boolean {
  const tm = toMinutes(t);
  const sm = toMinutes(start);
  const em = toMinutes(end);
  if (sm === em) return false;
  if (em > sm) return tm >= sm && tm < em;
  return tm >= sm || tm < em;
}

export interface WindowBounds {
  workStart: LocalHm;
  workEnd: LocalHm;
  returnStart: LocalHm;
  returnEnd: LocalHm;
}

/** 从设置里解析出四个窗口边界（供 cadence.ts 复用，避免重复解析逻辑）。 */
export function resolveWindowBounds(settings: Settings): WindowBounds {
  return {
    workStart: parseHm(settings.workWindowStart, DEFAULT_WORK_START),
    workEnd: parseHm(settings.workWindowEnd, DEFAULT_WORK_END),
    returnStart: parseHm(settings.returnWindowStart, DEFAULT_RETURN_START),
    returnEnd: parseHm(settings.returnWindowEnd, DEFAULT_RETURN_END),
  };
}

/** 对应 Kotlin 的 Windows.resolve(now, settings)：按 Europe/Oslo 本地时间判断当前窗口。 */
export function resolveWindow(date: Date, settings: Settings): CommuteWindow {
  const p = osloParts(date);
  const t: LocalHm = { hour: p.hour, minute: p.minute };
  const bounds = resolveWindowBounds(settings);
  if (inWindow(t, bounds.workStart, bounds.workEnd)) return "WORK";
  if (inWindow(t, bounds.returnStart, bounds.returnEnd)) return "RETURN";
  return "OUTSIDE";
}
